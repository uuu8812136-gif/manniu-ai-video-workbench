const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const BetterSqlite3 = require("better-sqlite3");

const appSlug = process.env.AI_TOOL_APP_SLUG?.trim() || require("../package.json").name;
if (!/^[a-z0-9][a-z0-9._-]*$/i.test(appSlug)) throw new Error(`Unsafe application slug: ${appSlug}`);
const targetDirectory = path.resolve(process.argv[2] || path.join("dist", "win-unpacked"));
const executablePath = path.join(targetDirectory, `${appSlug}.exe`);
if (!fs.existsSync(executablePath)) throw new Error(`Packaged executable not found: ${executablePath}`);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${appSlug}-crash-recovery-smoke-`));
  const databasePath = path.join(smokeRoot, `${appSlug}-data`, `${appSlug}.db`);
  const heldResponses = new Set();
  const modelServer = http.createServer((request, response) => {
    request.resume();
    heldResponses.add(response);
    response.on("close", () => heldResponses.delete(response));
  });
  await listen(modelServer);
  const address = modelServer.address();
  const modelBaseUrl = `http://127.0.0.1:${address.port}/v1`;
  let first = null;
  let second = null;

  try {
    first = await launchPackaged(smokeRoot);
    const firstPage = await waitForRenderer(first.port, () => first.exit);
    const firstCdp = await connectCdp(firstPage.webSocketDebuggerUrl);
    let targetJobId;
    let firstState;
    try {
      await waitForOfflineApi(firstCdp);
      const prepared = await evaluate(firstCdp, `
        (async () => {
          await window.offline.settings.set("text_polish_api_base_url", ${JSON.stringify(modelBaseUrl)});
          await window.offline.settings.set("text_polish_model", "crash-recovery-smoke");
          await window.offline.settings.set("text_polish_protocol", "responses");
          const jobs = [];
          for (let index = 0; index < 16; index += 1) {
            jobs.push(await window.offline.jobs.enqueue("text.polish", { text: "强杀恢复烟测 " + index }));
          }
          return jobs.map((job) => job.id);
        })()
      `);
      firstState = await waitForSaturatedQueue(firstCdp, prepared);
      targetJobId = firstState.queuedIds.at(-1);
      if (!targetJobId) throw new Error(`No queued job available for recovery target: ${JSON.stringify(firstState)}`);
    } finally {
      firstCdp.close();
    }

    promoteRecoveryTarget(databasePath, targetJobId);
    const beforeKill = readRecoveryEvidence(databasePath, targetJobId);
    if (beforeKill.status !== "running") {
      throw new Error(`Recovery target was not running before forced termination: ${JSON.stringify(beforeKill)}`);
    }

    await forceKill(first);
    first = null;
    await delay(1_500);

    second = await launchPackaged(smokeRoot);
    await waitForRenderer(second.port, () => second.exit);
    const recovered = await waitForRecovery(databasePath, targetJobId, () => second.exit);
    if (recovered.status !== "queued" || recovered.recoveryEvents !== 1) {
      throw new Error(`Interrupted job did not recover to queued exactly once: ${JSON.stringify(recovered)}`);
    }

    const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
    let quickCheck;
    let statusCounts;
    try {
      quickCheck = database.pragma("quick_check", { simple: true });
      statusCounts = Object.fromEntries(
        database.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").all()
          .map((row) => [row.status, row.count]),
      );
    } finally {
      database.close();
    }
    if (quickCheck !== "ok") throw new Error(`SQLite quick_check failed after crash recovery: ${quickCheck}`);

    console.log(JSON.stringify({
      status: "ok",
      executablePath,
      forcedTermination: true,
      samePortableDataDirectory: true,
      jobsRunningBeforeKill: firstState.runningIds.length + 1,
      targetJobId,
      recoveredStatus: recovered.status,
      recoveryEvent: "Interrupted job recovered and queued",
      recoveryEvents: recovered.recoveryEvents,
      statusCounts,
      sqliteQuickCheck: quickCheck,
    }, null, 2));
  } finally {
    if (first) await forceKill(first, false);
    if (second) await forceKill(second, false);
    for (const response of heldResponses) response.destroy();
    await closeServer(modelServer);
    await delay(500);
    fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function launchPackaged(smokeRoot) {
  const port = await availablePort();
  const child = spawn(executablePath, ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`], {
    cwd: targetDirectory,
    env: { ...process.env, PORTABLE_EXECUTABLE_DIR: smokeRoot },
    stdio: "ignore",
    windowsHide: true,
  });
  const state = { child, port, exit: null };
  child.once("exit", (code, signal) => { state.exit = { code, signal }; });
  return state;
}

async function forceKill(instance, required = true) {
  if (!instance.child.pid || instance.exit !== null) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(instance.child.pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (required && result.status !== 0) {
      throw new Error(`Unable to force-terminate packaged process ${instance.child.pid}: ${result.stderr || result.stdout}`);
    }
  } else {
    instance.child.kill("SIGKILL");
  }
  const deadline = Date.now() + 10_000;
  while (instance.exit === null && Date.now() < deadline) await delay(50);
  if (required && instance.exit === null) throw new Error(`Packaged process ${instance.child.pid} survived forced termination`);
}

function promoteRecoveryTarget(databasePath, targetJobId) {
  const database = new BetterSqlite3(databasePath, { fileMustExist: true });
  try {
    database.pragma("busy_timeout = 5000");
    const result = database.prepare(
      "UPDATE jobs SET status = 'running', created_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
    ).run("9999-12-31T23:59:59.999Z", new Date().toISOString(), targetJobId);
    if (result.changes !== 1) throw new Error(`Unable to prepare queued recovery target: ${targetJobId}`);
  } finally {
    database.close();
  }
}

function readRecoveryEvidence(databasePath, targetJobId) {
  const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
  try {
    const row = database.prepare("SELECT status, error FROM jobs WHERE id = ?").get(targetJobId);
    const event = database.prepare(
      "SELECT COUNT(*) AS count FROM job_events WHERE job_id = ? AND message = ?",
    ).get(targetJobId, "Interrupted job recovered and queued");
    const events = database.prepare(
      "SELECT level, message, detail_json AS detail FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT 5",
    ).all(targetJobId);
    return { status: row?.status ?? null, error: row?.error ?? null, recoveryEvents: event.count, events };
  } finally {
    database.close();
  }
}

async function waitForRecovery(databasePath, targetJobId, currentExit) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const exit = currentExit();
    if (exit) throw new Error(`Restarted packaged app exited during recovery: ${JSON.stringify(exit)}`);
    try {
      const evidence = readRecoveryEvidence(databasePath, targetJobId);
      if (evidence.status === "queued" && evidence.recoveryEvents === 1) return evidence;
    } catch {}
    await delay(50);
  }
  throw new Error(`Timed out waiting for interrupted job recovery: ${JSON.stringify(readRecoveryEvidence(databasePath, targetJobId))}`);
}

async function waitForSaturatedQueue(cdp, enqueuedIds) {
  const deadline = Date.now() + 15_000;
  let stableSignature = "";
  let stablePolls = 0;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await evaluate(cdp, `
      (async () => {
        const jobs = await window.offline.jobs.list();
        return {
          runningIds: jobs.filter((job) => job.status === "running").map((job) => job.id),
          queuedIds: jobs.filter((job) => job.status === "queued").map((job) => job.id)
        };
      })()
    `);
    const signature = `${latest.runningIds.length}:${latest.queuedIds.length}`;
    stablePolls = signature === stableSignature ? stablePolls + 1 : 0;
    stableSignature = signature;
    if (latest.runningIds.length > 0 && latest.queuedIds.length > 0 && stablePolls >= 3) {
      const observed = new Set([...latest.runningIds, ...latest.queuedIds]);
      if (enqueuedIds.every((id) => observed.has(id))) return latest;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for saturated packaged queue: ${JSON.stringify(latest)}`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForRenderer(port, currentExit) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const exit = currentExit();
    if (exit) throw new Error(`Packaged app exited during startup: ${JSON.stringify(exit)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await delay(150);
  }
  throw new Error("Timed out waiting for packaged renderer DevTools endpoint");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Unable to connect to packaged renderer CDP")), { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callbacks.reject(new Error(message.error.message));
    else callbacks.resolve(message.result);
  });
  return {
    call(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function waitForOfflineApi(cdp) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await cdp.call("Runtime.evaluate", {
      expression: "typeof window.offline?.jobs?.enqueue === 'function'",
      returnByValue: true,
    });
    if (result.result?.value === true) return;
    await delay(100);
  }
  throw new Error("Packaged preload API was not exposed");
}

async function evaluate(cdp, expression) {
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Renderer evaluation failed");
  return result.result.value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
