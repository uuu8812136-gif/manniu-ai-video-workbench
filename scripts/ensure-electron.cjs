const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const electronPackagePath = require.resolve("electron/package.json");
const electronRoot = path.dirname(electronPackagePath);
const electronPackage = require(electronPackagePath);
const installScript = path.join(electronRoot, "install.js");
const versionFile = path.join(electronRoot, "dist", "version");
const pathFile = path.join(electronRoot, "path.txt");

function readTrimmed(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function getExecutable() {
  const relativePath = readTrimmed(pathFile);
  return relativePath ? path.join(electronRoot, "dist", relativePath) : "";
}

function isInstalled() {
  const installedVersion = readTrimmed(versionFile).replace(/^v/, "");
  const executable = getExecutable();
  return installedVersion === electronPackage.version && executable && fs.existsSync(executable);
}

if (!isInstalled()) {
  const mirror = process.env.ELECTRON_MIRROR || "https://cdn.npmmirror.com/binaries/electron/";
  console.log(`[electron] Installing Electron ${electronPackage.version} from ${mirror}`);

  const result = spawnSync(process.execPath, [installScript], {
    cwd: electronRoot,
    env: {
      ...process.env,
      ELECTRON_MIRROR: mirror,
      npm_config_electron_mirror: mirror,
    },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Electron installer exited with code ${result.status ?? "unknown"}`);
  }
}

if (!isInstalled()) {
  throw new Error(`Electron ${electronPackage.version} installation is incomplete`);
}

const executable = getExecutable();
const versionCheck = spawnSync(executable, ["--version"], {
  encoding: "utf8",
  windowsHide: true,
});

if (versionCheck.error) {
  throw versionCheck.error;
}
if (versionCheck.status !== 0) {
  throw new Error(
    `Electron executable check failed with code ${versionCheck.status ?? "unknown"}: ${versionCheck.stderr || ""}`,
  );
}

const runtimeVersion = (versionCheck.stdout || versionCheck.stderr || "").trim();
console.log(`[electron] Ready: ${runtimeVersion} (${executable})`);
