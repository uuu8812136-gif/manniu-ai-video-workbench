import { constants, accessSync, mkdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { PROJECT_ASSET_DIRECTORY_NAME } from "../shared/asset-names";

const SUBTITLE_EXTENSIONS = new Set([".srt"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
export { PROJECT_ASSET_DIRECTORY_NAME };

export type ProjectCreationPaths = {
  folderPath: string;
  subtitlePath: string;
  audioPath: string;
};

export type ProjectMaterialPaths = Pick<ProjectCreationPaths, "subtitlePath" | "audioPath">;

function existingFile(path: string, label: string, extensions: Set<string>): string {
  const absolutePath = resolve(path.trim());
  if (!extensions.has(extname(absolutePath).toLowerCase())) throw new Error(`${label}格式不受支持`);
  let stats;
  try {
    stats = statSync(absolutePath);
    accessSync(absolutePath, constants.R_OK);
  } catch {
    throw new Error(`${label}不存在或无法读取`);
  }
  if (!stats.isFile()) throw new Error(`${label}必须是文件`);
  return absolutePath;
}

export function validateProjectCreationPaths(input: ProjectCreationPaths): ProjectCreationPaths {
  const folderPath = resolve(input.folderPath.trim());
  let stats;
  try {
    stats = statSync(folderPath);
    accessSync(folderPath, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error("项目目录不存在或不可写");
  }
  if (!stats.isDirectory()) throw new Error("项目目录必须是文件夹");
  return {
    folderPath,
    ...validateProjectMaterialPaths(input),
  };
}

export function validateProjectMaterialPaths(input: ProjectMaterialPaths): ProjectMaterialPaths {
  return {
    subtitlePath: existingFile(input.subtitlePath, "字幕文件", SUBTITLE_EXTENSIONS),
    audioPath: existingFile(input.audioPath, "音频文件", AUDIO_EXTENSIONS),
  };
}

export function ensureProjectDirectory(path: string): string {
  const folderPath = resolve(path.trim());
  try {
    mkdirSync(folderPath, { recursive: true });
    const stats = statSync(folderPath);
    accessSync(folderPath, constants.R_OK | constants.W_OK);
    if (!stats.isDirectory()) throw new Error("项目目录必须是文件夹");
  } catch (error) {
    if (error instanceof Error && error.message === "项目目录必须是文件夹") throw error;
    throw new Error("无法创建或写入项目目录");
  }
  return folderPath;
}

export function initializeProjectWorkspace(path: string): string {
  const folderPath = ensureProjectDirectory(path);
  const assetDirectory = join(folderPath, PROJECT_ASSET_DIRECTORY_NAME);
  try {
    mkdirSync(assetDirectory, { recursive: true });
    const stats = statSync(assetDirectory);
    accessSync(assetDirectory, constants.R_OK | constants.W_OK);
    if (!stats.isDirectory()) throw new Error("资产图路径必须是文件夹");
  } catch (error) {
    if (error instanceof Error && error.message === "资产图路径必须是文件夹") throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("资产图路径必须是文件夹");
    }
    throw new Error("无法创建或写入资产图目录");
  }
  return folderPath;
}

export function safeProjectDirectoryName(value: string): string {
  const normalized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/[. ]+$/gu, "")
    .slice(0, 120)
    .replace(/[. ]+$/gu, "");
  const fallback = normalized || "未命名项目";
  return WINDOWS_RESERVED_NAMES.test(fallback) ? `_${fallback}` : fallback;
}

export function createNamedProjectDirectory(rootPath: string, projectName: string): string {
  const root = ensureProjectDirectory(rootPath);
  const baseName = safeProjectDirectoryName(projectName);
  for (let suffix = 1; suffix <= 9_999; suffix += 1) {
    const name = suffix === 1 ? baseName : `${baseName} (${suffix})`;
    const folderPath = join(root, name);
    try {
      mkdirSync(folderPath);
      accessSync(folderPath, constants.R_OK | constants.W_OK);
      return initializeProjectWorkspace(folderPath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST") {
        continue;
      }
      throw new Error("无法创建或写入项目目录");
    }
  }
  throw new Error("同名项目目录过多，无法创建项目目录");
}
