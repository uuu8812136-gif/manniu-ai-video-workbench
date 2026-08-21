const asar = require("@electron/asar");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const skillResourceDirectories = ["inference-skill", "opening-skill", "hook-skill"];
const skillTextExtensions = new Set([
  ".cjs",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".jsonl",
  ".md",
  ".mjs",
  ".ps1",
  ".py",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const genericWindowsUserNames = new Set([
  "default",
  "demo",
  "example",
  "public",
  "sample",
  "test",
  "tester",
  "user",
  "username",
  "yourname",
  "your-name",
]);
const inferenceRuntimeFiles = [
  path.join("claude", "bin", "claude.exe"),
  path.join("python", "python.exe"),
  path.join("python", "python313.dll"),
  path.join("python", "python313.zip"),
  path.join("inference-skill", "CLAUDE.md"),
  path.join("inference-skill", "SKILL.md"),
  path.join("inference-skill", "verify_split_extreme.py"),
  path.join("inference-skill", "claude_openai_proxy.py"),
  path.join("inference-skill", "references", "asset-extraction.md"),
  path.join("inference-skill", "references", "prompt-assembly.md"),
  path.join("inference-skill", "references", "visual-reasoning.md"),
  path.join("inference-skill", "scripts", "segment.py"),
  path.join("inference-skill", "scripts", "build_storyboard_skeleton.py"),
  path.join("inference-skill", "scripts", "check_bcol.py"),
  path.join("inference-skill", "scripts", "check_dcol.py"),
];
const inferenceRuntimeAssetHashes = new Map([
  [path.join("inference-skill", "CLAUDE.md"), "50c4a08eb4c3e32f3000a7d1febc1cdc72608e6366be8d19521482083ebdf7e5"],
  [path.join("inference-skill", "verify_split_extreme.py"), "745dd18ccf2a894c4fae04812bc6638029cc500a5e869ff91cfab29dbb2ab510"],
]);

function main() {
const targetDirectory = path.resolve(process.argv[2] || path.join("dist", "win-unpacked"));
const resourcesDirectory = path.join(targetDirectory, "resources");
const archivePath = path.join(resourcesDirectory, "app.asar");
const executablePath = path.join(targetDirectory, "ai-tool.exe");
const nativeModulePath = path.join(
  resourcesDirectory,
  "app.asar.unpacked",
  "node_modules",
  "better-sqlite3",
  "prebuilds",
  "win32-x64.node",
);
const ffmpegDirectory = path.join(resourcesDirectory, "ffmpeg");
const ffmpegRuntimeFiles = [
  "LICENSE.txt",
  "NOTICE.txt",
  path.join("bin", "ffmpeg.exe"),
  path.join("bin", "ffprobe.exe"),
  path.join("bin", "avcodec-63.dll"),
  path.join("bin", "avdevice-63.dll"),
  path.join("bin", "avfilter-12.dll"),
  path.join("bin", "avformat-63.dll"),
  path.join("bin", "avutil-61.dll"),
  path.join("bin", "swresample-7.dll"),
  path.join("bin", "swscale-10.dll"),
];
const ffmpegRuntimePaths = ffmpegRuntimeFiles.map((entry) => path.join(ffmpegDirectory, entry));
const inferenceRuntimePaths = inferenceRuntimeFiles.map((entry) => path.join(resourcesDirectory, entry));
const openingRuntimeFiles = [
  path.join("opening-skill", "general", "CLAUDE.md"),
  path.join("opening-skill", "general", ".claude", "skills", "novel-optimizer", "SKILL.md"),
  path.join("opening-skill", "general", "references", "文案大全.xlsx"),
  path.join("opening-skill", "enhanced", "CLAUDE.md"),
  path.join("opening-skill", "enhanced", ".claude", "skills", "novel-optimizer", "SKILL.md"),
  path.join("opening-skill", "enhanced", "rules_check.md"),
  path.join("opening-skill", "enhanced", "rules_step3_detail.md"),
  path.join("hook-skill", "SKILL.md"),
  path.join("hook-skill", "scripts", "verify_hook.py"),
];
const openingRuntimePaths = openingRuntimeFiles.map((entry) => path.join(resourcesDirectory, entry));

for (const requiredFile of [executablePath, archivePath, nativeModulePath, ...ffmpegRuntimePaths, ...inferenceRuntimePaths, ...openingRuntimePaths]) {
  if (!fs.existsSync(requiredFile)) throw new Error(`Missing packaged runtime file: ${requiredFile}`);
}
for (const [relativePath, expectedHash] of inferenceRuntimeAssetHashes) {
  const assetPath = path.join(resourcesDirectory, relativePath);
  const actualHash = crypto.createHash("sha256").update(fs.readFileSync(assetPath)).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`Original inference runtime asset hash mismatch: ${relativePath} (${actualHash})`);
  }
}
const skillResourceAudit = auditSkillResources(resourcesDirectory);

const entries = asar.listPackage(archivePath).map(normalizeEntry);
const entrySet = new Set(entries);
const requiredEntries = ["out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html", "package.json"];
for (const entry of requiredEntries) {
  if (!entrySet.has(entry)) throw new Error(`Missing app.asar entry: ${entry}`);
}

const forbiddenPrefixes = ["src/", "tests/", "scripts/", "work/", "coverage/"];
const forbiddenEntries = entries.filter(
  (entry) => forbiddenPrefixes.some((prefix) => entry.startsWith(prefix)) || entry.endsWith(".map"),
);
if (forbiddenEntries.length > 0) {
  throw new Error(`Development files found in app.asar: ${forbiddenEntries.slice(0, 10).join(", ")}`);
}

const forbiddenPrograms = entries.filter((entry) => /(?:^|\/)(?:pythonw?|claude)(?:\.exe)?$/i.test(entry));
if (forbiddenPrograms.length > 0) {
  throw new Error(`Forbidden external runtime found in app.asar: ${forbiddenPrograms.join(", ")}`);
}

const forbiddenMarkers = [
  "101.42.2.100",
  "/api/v2/auth/login",
  "/api/auth/verify",
  "/api/project-log",
  "示例短片",
  "开发预览不写入",
  "dev-mock",
];
const textExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".mjs", ".txt"]);
for (const entry of entries) {
  if (entry !== "package.json" && !entry.startsWith("out/")) continue;
  if (!textExtensions.has(path.extname(entry).toLowerCase())) continue;
  const content = asar.extractFile(archivePath, entry.split("/").join(path.sep)).toString("utf8");
  const marker = forbiddenMarkers.find((value) => content.includes(value));
  if (marker) throw new Error(`Forbidden original-service marker ${marker} found in ${entry}`);
}

const packagedManifest = JSON.parse(asar.extractFile(archivePath, "package.json").toString("utf8"));
if (packagedManifest.main !== "./out/main/index.js") {
  throw new Error(`Unexpected packaged main entry: ${packagedManifest.main}`);
}
if (packagedManifest.scripts) throw new Error("Package scripts must be removed from the production manifest");

const devPackages = ["electron-vite", "typescript", "vitest"];
const bundledDevPackages = devPackages.filter((name) =>
  entries.some((entry) => entry === `node_modules/${name}` || entry.startsWith(`node_modules/${name}/`)),
);
if (bundledDevPackages.length > 0) {
  throw new Error(`Development dependencies found in app.asar: ${bundledDevPackages.join(", ")}`);
}

console.log(
  JSON.stringify(
    {
      status: "ok",
      targetDirectory,
      executableBytes: fs.statSync(executablePath).size,
      archiveBytes: fs.statSync(archivePath).size,
      nativeModuleBytes: fs.statSync(nativeModulePath).size,
      ffmpegExecutableBytes: fs.statSync(path.join(ffmpegDirectory, "bin", "ffmpeg.exe")).size,
      ffprobeExecutableBytes: fs.statSync(path.join(ffmpegDirectory, "bin", "ffprobe.exe")).size,
      ffmpegRuntimeFiles: ffmpegRuntimeFiles.length,
      archiveEntries: entries.length,
      originalServiceMarkers: 0,
      inferenceRuntimeFiles: inferenceRuntimeFiles.length,
      claudeExecutableBytes: fs.statSync(path.join(resourcesDirectory, "claude", "bin", "claude.exe")).size,
      openingRuntimeFiles: openingRuntimeFiles.length,
      auditedSkillResourceFiles: skillResourceAudit.files,
      auditedSkillTextFiles: skillResourceAudit.textFiles,
      bundledValidationRuntimes: 1,
    },
    null,
    2,
  ),
);
}

function auditSkillResources(resourcesDirectory) {
  let files = 0;
  let textFiles = 0;
  for (const directoryName of skillResourceDirectories) {
    const root = path.join(resourcesDirectory, directoryName);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error(`Missing packaged skill resource directory: ${root}`);
    }
    walkSkillDirectory(root, directoryName, (filePath, relativePath) => {
      files += 1;
      const extension = path.extname(filePath).toLowerCase();
      if (extension === ".pyc") {
        throw new Error(`Forbidden Python cache file found in packaged skill resources: ${relativePath}`);
      }
      if (!skillTextExtensions.has(extension)) return;
      textFiles += 1;
      const localPath = findLocalWindowsUserPath(fs.readFileSync(filePath, "utf8"));
      if (localPath) {
        throw new Error(`Local Windows user path found in packaged skill resource: ${relativePath}`);
      }
    });
  }
  return { files, textFiles };
}

function walkSkillDirectory(directory, relativeDirectory, visitFile) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.name.toLowerCase() === "__pycache__") {
      throw new Error(`Forbidden Python cache directory found in packaged skill resources: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      walkSkillDirectory(entryPath, relativePath, visitFile);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported packaged skill resource entry: ${relativePath}`);
    }
    visitFile(entryPath, relativePath);
  }
}

function findLocalWindowsUserPath(content) {
  const pattern = /\b[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'`<>]+)/giu;
  for (const match of content.matchAll(pattern)) {
    const userName = match[1].replace(/\\+$/u, "");
    if (isGenericWindowsUserName(userName)) continue;
    return match[0];
  }
  return null;
}

function isGenericWindowsUserName(value) {
  const normalized = value.toLowerCase();
  return genericWindowsUserNames.has(normalized)
    || /^%[^%]+%$/u.test(value)
    || /^\$\{[^}]+\}$/u.test(value)
    || /^\{[^}]+\}$/u.test(value)
    || /^\[[^\]]+\]$/u.test(value);
}

function normalizeEntry(entry) {
  return entry.replace(/\\/g, "/").replace(/^\/+/, "");
}

if (require.main === module) main();

module.exports = {
  auditSkillResources,
  findLocalWindowsUserPath,
  inferenceRuntimeFiles,
  inferenceRuntimeAssetHashes,
};
