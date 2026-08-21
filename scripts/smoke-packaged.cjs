const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const targetDirectory = path.resolve(process.argv[2] || path.join("dist", "win-unpacked"));
const executablePath = path.join(targetDirectory, "ai-tool.exe");
if (!fs.existsSync(executablePath)) throw new Error(`Packaged executable not found: ${executablePath}`);

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tool-packaged-smoke-"));
const databasePath = path.join(smokeRoot, "ai-tool-data", "ai-tool.db");
const child = spawn(executablePath, [], {
  cwd: targetDirectory,
  env: { ...process.env, PORTABLE_EXECUTABLE_DIR: smokeRoot },
  stdio: "ignore",
  windowsHide: true,
});

let exit = null;
child.once("exit", (code, signal) => {
  exit = { code, signal };
});

try {
  const deadline = Date.now() + 20_000;
  while (!isSqliteDatabase(databasePath) && exit === null && Date.now() < deadline) sleep(200);
  if (exit !== null) throw new Error(`Packaged app exited during startup: ${JSON.stringify(exit)}`);
  if (!isSqliteDatabase(databasePath)) throw new Error(`Packaged app did not initialize SQLite: ${databasePath}`);

  console.log(
    JSON.stringify(
      {
        status: "ok",
        executablePath,
        processId: child.pid,
        portableUserData: true,
        sqliteCreated: true,
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
  sleep(500);
  fs.rmSync(smokeRoot, { recursive: true, force: true });
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
