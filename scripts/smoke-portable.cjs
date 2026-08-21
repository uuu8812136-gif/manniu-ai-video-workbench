const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDirectory = path.resolve(process.argv[2] || "dist");
const artifact = fs
  .readdirSync(outputDirectory)
  .filter((name) => /^ai-tool-portable-.*-x64\.exe$/i.test(name))
  .sort()
  .at(-1);
if (!artifact) throw new Error(`Portable artifact not found in ${outputDirectory}`);

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tool-portable-smoke-"));
const executablePath = path.join(smokeRoot, "ai-tool-portable.exe");
const databasePath = path.join(smokeRoot, "ai-tool-data", "ai-tool.db");
fs.copyFileSync(path.join(outputDirectory, artifact), executablePath);

const child = spawn(executablePath, [], { cwd: smokeRoot, stdio: "ignore", windowsHide: true });
let exit = null;
child.once("exit", (code, signal) => {
  exit = { code, signal };
});

try {
  const deadline = Date.now() + 30_000;
  while (!isSqliteDatabase(databasePath) && exit === null && Date.now() < deadline) sleep(250);
  if (exit !== null) throw new Error(`Portable app exited during startup: ${JSON.stringify(exit)}`);
  if (!isSqliteDatabase(databasePath)) throw new Error(`Portable app did not initialize SQLite beside itself: ${databasePath}`);

  console.log(
    JSON.stringify(
      {
        status: "ok",
        sourceArtifact: artifact,
        processId: child.pid,
        launcherInjectedPortablePath: true,
        sqliteCreatedBesideLauncher: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (child.pid && exit === null) {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  }
  sleep(1_000);
  fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

function sleep(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function isSqliteDatabase(file) {
  try {
    if (fs.statSync(file).size < 16) return false;
    return fs.readFileSync(file).subarray(0, 16).toString("binary") === "SQLite format 3\u0000";
  } catch {
    return false;
  }
}
