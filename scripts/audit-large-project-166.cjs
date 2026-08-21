const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const Database = require("better-sqlite3");

const root = path.resolve(__dirname, "..");
const electron = path.join(
  root,
  "node_modules",
  ".pnpm",
  "electron@43.2.0",
  "node_modules",
  "electron",
  "dist",
  "electron.exe",
);
const outputPath = path.resolve(
  process.argv[2] || path.join(root, "audit", "evidence", "large-project-166.json"),
);
const screenshotPath = path.resolve(
  process.argv[3] || path.join(root, "audit", "evidence", "large-project-166.png"),
);
const artifactRoot = path.join(path.dirname(outputPath), "large-project-166-artifacts");
const userData = path.join(artifactRoot, "user-data");
const projectDirectory = path.join(artifactRoot, "project");
const networkLog = path.join(artifactRoot, "network.jsonl");
const electronLog = path.join(artifactRoot, "electron.log");
const storyboardCount = 166;
const observationMs = 11_200;
const thresholds = {
  firstRenderMs: 5_000,
  maxCallsPerPolledChannel: 4,
  maxPendingPerPolledChannel: 1,
  minimumPollGapMs: 3_500,
  maxMediaElements: 24,
  sidebarWidthTolerancePx: 2,
};
const polledChannels = [
  "storyboards:list",
  "character-profiles:list",
  "vidu-accounts:list",
  "jobs:latest-for-storyboards",
];

if (!fs.existsSync(electron)) throw new Error(`Electron executable not found: ${electron}`);
if (!fs.existsSync(path.join(root, "out", "main", "index.js"))) {
  throw new Error("Development build missing. Run pnpm build before this audit.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  fs.rmSync(artifactRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  fs.mkdirSync(projectDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFixturePng(path.join(projectDirectory, "preview.png"));

  const port = await availablePort();
  const log = fs.openSync(electronLog, "w");
  const child = spawn(
    electron,
    [root, "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
    {
      cwd: root,
      env: {
        ...process.env,
        AI_TOOL_TEST_INTERACTION_AUDIT: "1",
        AI_TOOL_TEST_BLOCK_EXTERNAL_NETWORK: "1",
        AI_TOOL_TEST_NETWORK_LOG: networkLog,
      },
      stdio: ["ignore", log, log],
      windowsHide: true,
    },
  );
  let exited = null;
  child.once("exit", (code, signal) => { exited = { code, signal }; });
  let cdp;
  try {
    const page = await waitForRenderer(port, () => exited);
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.call("Page.enable");
    await cdp.call("Performance.enable");
    await setWindowSize(cdp, 1440, 700);
    await waitForAuditApi(cdp);

    const seed = await evaluate(cdp, seedExpression());
    markStoryboardsDone(seed.database, seed.project.id, path.join(projectDirectory, "preview.png"));

    await evaluate(cdp, `
      window.__AI_TOOL_INTERACTION_AUDIT__.clear();
      window.__LARGE_PROJECT_AUDIT_START__ = performance.now();
      window.location.hash = ${JSON.stringify(`#/project/${seed.project.id}`)};
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      true;
    `);

    const runtime = await observeRuntime(cdp, observationMs);
    const initialLayout = await measureLayout(cdp);
    const initialDom = await measureDom(cdp);
    const mediaAfterBottom = await scrollAndMeasureMedia(cdp, "bottom");
    const bottomLayout = await measureLayout(cdp);
    const mediaAfterTop = await scrollAndMeasureMedia(cdp, "top");
    const finalLayout = await measureLayout(cdp);
    const screenshot = await cdp.call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true,
    });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));

    const perfMetrics = summarizePerformanceMetrics(await cdp.call("Performance.getMetrics"));
    const calls = await evaluate(cdp, "window.__AI_TOOL_INTERACTION_AUDIT__.snapshot()");
    const ipc = summarizeIpc(calls, runtime.maxPendingByChannel);
    const blockedExternalRequests = readJsonLines(networkLog).filter((item) => item.event === "blocked");
    const assertions = buildAssertions({
      firstRenderMs: runtime.firstRenderMs,
      initialDom,
      initialLayout,
      bottomLayout,
      finalLayout,
      mediaCounts: [runtime.maxMediaElements, initialDom.mediaElements, mediaAfterBottom, mediaAfterTop],
      ipc,
      blockedExternalRequests,
    });
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: `ai-tool-${readPackageVersion()}-development-electron`,
      fixture: {
        storyboards: storyboardCount,
        status: "done",
        media: "one local PNG shared by all rows",
        userData,
        database: seed.database,
        externalNetworkBlocked: true,
        realViduTriggered: false,
      },
      thresholds,
      timing: {
        firstRenderMs: round(runtime.firstRenderMs),
        observationMs,
        sampleCount: runtime.sampleCount,
        wallClockMs: round(runtime.wallClockMs),
      },
      ipc,
      dom: {
        ...initialDom,
        maxMediaElementsDuringObservation: runtime.maxMediaElements,
        mediaElementsAfterBottomScroll: mediaAfterBottom,
        mediaElementsAfterReturnToTop: mediaAfterTop,
      },
      layout: {
        initial: initialLayout,
        afterMainScroll: bottomLayout,
        afterReturnToTop: finalLayout,
      },
      performance: perfMetrics,
      network: {
        blockedExternalRequestCount: blockedExternalRequests.length,
        blockedExternalRequests,
      },
      evidence: { screenshot: screenshotPath, electronLog },
      assertions,
      summary: {
        passed: assertions.every((assertion) => assertion.passed),
        passedCount: assertions.filter((assertion) => assertion.passed).length,
        failedCount: assertions.filter((assertion) => !assertion.passed).length,
      },
    };
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ outputPath, screenshotPath, summary: report.summary, timing: report.timing, ipc: report.ipc.counts, dom: report.dom, layout: report.layout.initial }, null, 2));
    if (!report.summary.passed) process.exitCode = 1;
  } finally {
    cdp?.close();
    if (child.pid && exited === null) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
    fs.closeSync(log);
  }
}

function seedExpression() {
  const drafts = Array.from({ length: storyboardCount }, (_, index) => ({
    index,
    originalText: `Large project source line ${index + 1}`,
    subjects: [`Character ${index % 12 + 1}`],
    prompt: `Wide cinematic shot ${index + 1}, stable composition, clear subject motion`,
    duration: index % 3 + 3,
  }));
  const project = {
    name: "Large Project 166 Runtime Audit",
    folderPath: projectDirectory,
  };
  return `(async () => {
    const project = await window.offline.projects.create(${JSON.stringify(project)});
    await window.offline.settings.set('video_provider', 'custom-api');
    await window.offline.storyboards.replace(project.id, ${JSON.stringify(drafts)});
    await window.offline.characterProfiles.replace(project.id, ${JSON.stringify(Array.from({ length: 12 }, (_, index) => ({
      name: `Character ${index + 1}`,
      identity: "fixture",
      gender: "unknown",
      age: "adult",
      appearance: `Large project fixture profile ${index + 1}`,
      hair: "fixture",
      clothing: "fixture",
      personality: "fixture",
      visualPrompt: `Consistent character profile ${index + 1}`,
      assetType: "character",
    })))});
    const paths = await window.offline.app.paths();
    return { project, database: paths.database };
  })()`;
}

function markStoryboardsDone(databasePath, projectId, imagePath) {
  const db = new Database(databasePath);
  try {
    db.pragma("busy_timeout = 5000");
    const now = new Date().toISOString();
    db.prepare("UPDATE storyboards SET status='done', image_paths_json=?, updated_at=? WHERE project_id=?")
      .run(JSON.stringify([imagePath]), now, projectId);
  } finally {
    db.close();
  }
}

async function observeRuntime(cdp, durationMs) {
  const startedAt = performance.now();
  const deadline = startedAt + durationMs;
  let firstRenderMs = null;
  let sampleCount = 0;
  let maxMediaElements = 0;
  const maxPendingByChannel = {};
  while (performance.now() < deadline || firstRenderMs === null) {
    const sample = await evaluate(cdp, `(() => {
      const calls = window.__AI_TOOL_INTERACTION_AUDIT__.snapshot();
      const pending = {};
      for (const call of calls) if (call.status === 'pending') pending[call.channel] = (pending[call.channel] || 0) + 1;
      return {
        elapsed: performance.now() - window.__LARGE_PROJECT_AUDIT_START__,
        rows: document.querySelectorAll('.storyboard-card-row').length,
        sidebar: Boolean(document.querySelector('.automation-sidebar')),
        mediaElements: document.querySelectorAll('.storyboard-media-preview video, .storyboard-media-preview img').length,
        pending,
      };
    })()`);
    sampleCount += 1;
    maxMediaElements = Math.max(maxMediaElements, sample.mediaElements);
    for (const [channel, count] of Object.entries(sample.pending)) {
      maxPendingByChannel[channel] = Math.max(maxPendingByChannel[channel] || 0, count);
    }
    if (firstRenderMs === null && sample.rows === storyboardCount && sample.sidebar) firstRenderMs = sample.elapsed;
    if (performance.now() >= deadline && firstRenderMs !== null) break;
    if (performance.now() - startedAt > 20_000) throw new Error("Timed out waiting for 166 storyboard rows");
    await delay(25);
  }
  return { firstRenderMs, sampleCount, maxMediaElements, maxPendingByChannel, wallClockMs: performance.now() - startedAt };
}

async function measureDom(cdp) {
  return evaluate(cdp, `(() => {
    const projectTitle = document.querySelector('.automation-project-name');
    const projectTitleStyle = getComputedStyle(projectTitle);
    const lineHeight = Number.parseFloat(projectTitleStyle.lineHeight);
    return {
      storyboardRows: document.querySelectorAll('.storyboard-card-row').length,
      totalElements: document.querySelectorAll('*').length,
      mediaPreviewContainers: document.querySelectorAll('.storyboard-media-preview').length,
      mediaElements: document.querySelectorAll('.storyboard-media-preview video, .storyboard-media-preview img').length,
      rowTextareas: document.querySelectorAll('.storyboard-card-row textarea').length,
      staticFieldButtons: document.querySelectorAll('.storyboard-card-row .storyboard-static-field').length,
      projectTitle: {
        text: projectTitle.textContent,
        clientWidth: projectTitle.clientWidth,
        scrollWidth: projectTitle.scrollWidth,
        clientHeight: projectTitle.clientHeight,
        scrollHeight: projectTitle.scrollHeight,
        lineCount: Number.isFinite(lineHeight) && lineHeight > 0 ? Math.round(projectTitle.clientHeight / lineHeight) : null,
        overflow: projectTitleStyle.overflow,
        textOverflow: projectTitleStyle.textOverflow,
        whiteSpace: projectTitleStyle.whiteSpace,
      },
    };
  })()`);
}

async function measureLayout(cdp) {
  return evaluate(cdp, `(() => {
    const workspace = document.querySelector('.project-detail-workspace');
    const main = document.querySelector('.project-storyboard-main');
    const sidebar = document.querySelector('.automation-sidebar');
    const rect = (element) => { const value = element.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height }; };
    const style = (element) => getComputedStyle(element);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      workspace: rect(workspace),
      main: { ...rect(main), scrollTop: main.scrollTop, scrollHeight: main.scrollHeight, clientHeight: main.clientHeight, overflowY: style(main).overflowY },
      sidebar: { ...rect(sidebar), scrollTop: sidebar.scrollTop, scrollHeight: sidebar.scrollHeight, clientHeight: sidebar.clientHeight, overflowY: style(sidebar).overflowY },
    };
  })()`);
}

async function scrollAndMeasureMedia(cdp, direction) {
  return evaluate(cdp, `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const main = document.querySelector('.project-storyboard-main');
    const sidebar = document.querySelector('.automation-sidebar');
    if (${JSON.stringify(direction)} === 'bottom') {
      main.scrollTop = main.scrollHeight;
      sidebar.scrollTop = sidebar.scrollHeight;
    } else {
      main.scrollTop = 0;
      sidebar.scrollTop = 0;
    }
    await wait(600);
    return document.querySelectorAll('.storyboard-media-preview video, .storyboard-media-preview img').length;
  })()`);
}

function summarizeIpc(calls, maxPendingByChannel) {
  const counts = {};
  const rejected = [];
  const starts = {};
  for (const call of calls) {
    counts[call.channel] = (counts[call.channel] || 0) + 1;
    (starts[call.channel] ||= []).push(Date.parse(call.at));
    if (call.status === "rejected") rejected.push({ channel: call.channel, error: call.error });
  }
  const minimumGapsMs = {};
  for (const [channel, values] of Object.entries(starts)) {
    minimumGapsMs[channel] = values.length < 2
      ? null
      : Math.min(...values.slice(1).map((value, index) => value - values[index]));
  }
  return {
    counts,
    minimumGapsMs,
    maxPendingByChannel,
    rejected,
    legacyGlobalJobsListCalls: counts["jobs:list"] || 0,
    jobEventCalls: counts["jobs:events"] || 0,
    totalCalls: calls.length,
  };
}

function buildAssertions(input) {
  const mediaPeak = Math.max(...input.mediaCounts);
  const results = [
    ["renders all 166 storyboard rows", input.initialDom.storyboardRows === storyboardCount, input.initialDom.storyboardRows],
    ["first render remains under pragmatic threshold", input.firstRenderMs <= thresholds.firstRenderMs, round(input.firstRenderMs)],
    ["uses static row fields instead of per-row textareas", input.initialDom.rowTextareas === 0 && input.initialDom.staticFieldButtons === storyboardCount * 3, input.initialDom],
    ["viewport media remains bounded", mediaPeak <= thresholds.maxMediaElements, mediaPeak],
    ["sidebar is 316px", Math.abs(input.initialLayout.sidebar.width - 316) <= thresholds.sidebarWidthTolerancePx, input.initialLayout.sidebar.width],
    ["main pane is independently scrollable", input.initialLayout.main.scrollHeight > input.initialLayout.main.clientHeight && input.initialLayout.main.overflowY === "auto" && input.bottomLayout.main.scrollTop > 0, input.bottomLayout.main],
    ["sidebar is independently scrollable", input.initialLayout.sidebar.scrollHeight > input.initialLayout.sidebar.clientHeight && input.initialLayout.sidebar.overflowY === "auto" && input.bottomLayout.sidebar.scrollTop > 0, input.bottomLayout.sidebar],
    ["main and sidebar return to top independently", input.finalLayout.main.scrollTop === 0 && input.finalLayout.sidebar.scrollTop === 0, input.finalLayout],
    ["project polling avoids global jobs:list", input.ipc.legacyGlobalJobsListCalls === 0, input.ipc.legacyGlobalJobsListCalls],
    ["completed fixture does not fetch job events", input.ipc.jobEventCalls === 0, input.ipc.jobEventCalls],
    ["IPC calls settle without rejection", input.ipc.rejected.length === 0, input.ipc.rejected],
    ["audit does not attempt external network", input.blockedExternalRequests.length === 0, input.blockedExternalRequests],
  ];
  for (const channel of polledChannels) {
    const count = input.ipc.counts[channel] || 0;
    const maxPending = input.ipc.maxPendingByChannel[channel] || 0;
    const gap = input.ipc.minimumGapsMs[channel];
    results.push([`${channel} call count stays bounded`, count >= 3 && count <= thresholds.maxCallsPerPolledChannel, count]);
    results.push([`${channel} never overlaps itself`, maxPending <= thresholds.maxPendingPerPolledChannel, maxPending]);
    results.push([`${channel} poll gap remains near 5 seconds`, gap === null || gap >= thresholds.minimumPollGapMs, gap]);
  }
  return results.map(([name, passed, actual]) => ({ name, passed: Boolean(passed), actual }));
}

function summarizePerformanceMetrics(response) {
  const wanted = new Set(["Timestamp", "Documents", "Frames", "JSEventListeners", "Nodes", "LayoutCount", "RecalcStyleCount", "JSHeapUsedSize", "JSHeapTotalSize", "TaskDuration"]);
  return Object.fromEntries(response.metrics.filter((item) => wanted.has(item.name)).map((item) => [item.name, round(item.value)]));
}

async function setWindowSize(cdp, width, height) {
  try {
    const { windowId } = await cdp.call("Browser.getWindowForTarget");
    await cdp.call("Browser.setWindowBounds", { windowId, bounds: { width, height, windowState: "normal" } });
    await delay(250);
  } catch {
    // BrowserWindow already defaults to 1440 wide; the report records the actual viewport.
  }
}

function writeFixturePng(filePath) {
  const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  fs.writeFileSync(filePath, Buffer.from(onePixelPng, "base64"));
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function readPackageVersion() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForRenderer(port, currentExit) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (currentExit()) throw new Error(`Electron exited during startup: ${JSON.stringify(currentExit())}`);
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await delay(120);
  }
  throw new Error("Timed out waiting for Electron renderer CDP");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Unable to connect renderer CDP")), { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const task = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  });
  return {
    call(method, params = {}) {
      const callId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(callId, { resolve, reject });
        socket.send(JSON.stringify({ id: callId, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function waitForAuditApi(cdp) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await evaluate(cdp, "typeof window.offline?.projects?.create === 'function' && typeof window.__AI_TOOL_INTERACTION_AUDIT__?.snapshot === 'function'");
    if (ready) return;
    await delay(100);
  }
  throw new Error("Preload interaction audit API was not exposed");
}

async function evaluate(cdp, expression) {
  const response = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Renderer evaluation failed");
  }
  return response.result.value;
}

function round(value) {
  return typeof value === "number" ? Math.round(value * 100) / 100 : value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
