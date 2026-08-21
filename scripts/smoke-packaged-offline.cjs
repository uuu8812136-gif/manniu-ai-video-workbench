const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

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
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${appSlug}-offline-smoke-`));
  const databasePath = path.join(smokeRoot, `${appSlug}-data`, `${appSlug}.db`);
  const networkLogPath = path.join(smokeRoot, "network-guard.jsonl");
  const port = await availablePort();
  const child = spawn(executablePath, [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`], {
    cwd: targetDirectory,
    env: {
      ...process.env,
      PORTABLE_EXECUTABLE_DIR: smokeRoot,
      AI_TOOL_TEST_BLOCK_EXTERNAL_NETWORK: "1",
      AI_TOOL_TEST_NETWORK_LOG: networkLogPath,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  let exit = null;
  child.once("exit", (code, signal) => { exit = { code, signal }; });

  try {
    const page = await waitForRenderer(port, () => exit);
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    let mediaHealth = null;
    try {
      await waitForOfflineApi(cdp);
      const result = await evaluate(cdp, `
        (async () => {
          const initial = await window.offline.projects.list();
          const created = await window.offline.projects.create({
            name: "断网 CRUD 中文项目",
            folderPath: "D:\\\\AI工具 项目\\\\素材"
          });
          const updated = await window.offline.projects.update(created.id, { name: "断网 CRUD 已更新" });
          const listed = await window.offline.projects.list();
          await window.offline.projects.delete(created.id);
          const final = await window.offline.projects.list();
          const mediaHealth = await window.offline.media.health({
            ffmpegPath: "ffmpeg",
            ffprobePath: "ffprobe"
          });
          let externalBlocked = false;
          try { await fetch("https://offline-gate.invalid/probe"); } catch { externalBlocked = true; }
          return {
            initialCount: initial.length,
            createdId: created.id,
            updatedName: updated.name,
            listed: listed.some((item) => item.id === created.id && item.name === updated.name),
            deleted: !final.some((item) => item.id === created.id),
            externalBlocked,
            mediaHealth
          };
        })()
      `);
      if (!result.listed || !result.deleted || !result.externalBlocked || result.updatedName !== "断网 CRUD 已更新") {
        throw new Error(`Packaged offline CRUD assertion failed: ${JSON.stringify(result)}`);
      }
      if (!result.mediaHealth?.ok || !result.mediaHealth.ffmpeg?.ok || !result.mediaHealth.ffprobe?.ok) {
        throw new Error(`Bundled FFmpeg health assertion failed: ${JSON.stringify(result.mediaHealth)}`);
      }
      mediaHealth = result.mediaHealth;
    } finally {
      cdp.close();
    }

    if (!isSqliteDatabase(databasePath)) throw new Error(`Packaged app did not initialize SQLite: ${databasePath}`);
    const networkEvents = fs.readFileSync(networkLogPath, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    const activeEvents = networkEvents.filter((event) => event.event === "active");
    const blockedEvents = networkEvents.filter((event) => event.event === "blocked");
    const expectedProbe = "https://offline-gate.invalid/probe";
    if (activeEvents.length !== 1 || blockedEvents.length !== 1
      || blockedEvents[0].source !== "renderer" || blockedEvents[0].url !== expectedProbe) {
      throw new Error(`Unexpected packaged-app external network attempts: ${JSON.stringify(networkEvents)}`);
    }
    console.log(JSON.stringify({
      status: "ok",
      executablePath,
      sqliteCreated: true,
      packagedRendererCrud: true,
      externalNetworkBlocked: true,
      bundledFfmpegAvailable: true,
      ffmpegVersion: mediaHealth.ffmpeg.version,
      ffprobeVersion: mediaHealth.ffprobe.version,
      firewallRulesChanged: false,
    }, null, 2));
  } finally {
    if (child.pid && exit === null) {
      if (process.platform === "win32") {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    }
    await delay(500);
    fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
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
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
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
      expression: "typeof window.offline?.projects?.create === 'function'",
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

function isSqliteDatabase(file) {
  try {
    if (fs.statSync(file).size < 16) return false;
    return fs.readFileSync(file).subarray(0, 16).toString("binary") === "SQLite format 3\u0000";
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
