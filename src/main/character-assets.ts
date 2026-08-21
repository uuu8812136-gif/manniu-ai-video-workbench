import { copyFile, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { CharacterProfile } from "../shared/contracts";

const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const ASSET_DIRECTORIES = ["资产图", "assets"] as const;

export function characterAssetFileStem(name: string): string {
  const normalized = name.trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "");
  return (normalized || "asset").slice(0, 120);
}

export function characterAssetPrompt(basePrompt: string, profiles: readonly CharacterProfile[]): string {
  const prompt = basePrompt.trim();
  if (profiles.length === 0) return prompt;
  const profileLines = profiles.map((profile) => {
    const type = profile.assetType === "scene"
      ? "场景"
      : profile.assetType === "special-space"
        ? "特殊空间"
        : "人物";
    return `- ${profile.name}（${type}）：${profile.prompt.trim() || profile.visualPrompt.trim()}`;
  });
  return [
    "资产一致性设定：",
    ...profileLines,
    "分镜画面：",
    prompt,
  ].join("\n");
}

export async function findCharacterAsset(projectDirectory: string, name: string): Promise<string | null> {
  const names = new Set(
    [name.trim(), characterAssetFileStem(name)]
      .filter(Boolean)
      .map((value) => value.toLocaleLowerCase()),
  );
  for (const directoryName of ASSET_DIRECTORIES) {
    const directory = join(resolve(projectDirectory), directoryName);
    let entries: string[];
    try {
      entries = (await readdir(directory)).sort((left, right) => left.localeCompare(right));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const extension = extname(entry).toLowerCase();
      if (!ASSET_EXTENSIONS.has(extension) || !names.has(entry.slice(0, -extension.length).toLocaleLowerCase())) continue;
      const candidate = join(directory, entry);
      try {
        const info = await lstat(candidate);
        if (info.isFile() && !info.isSymbolicLink()) return candidate;
      } catch {
        // Continue looking for another supported asset file.
      }
    }
  }
  return null;
}

export async function preflightCharacterAssets(
  projectDirectory: string,
  names: readonly string[],
): Promise<Map<string, string>> {
  const uniqueNames = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
  const assets = new Map<string, string>();
  const missing: string[] = [];
  for (const name of uniqueNames) {
    const asset = await findCharacterAsset(projectDirectory, name);
    if (asset) assets.set(name, asset);
    else missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error([
      `项目缺少 ${missing.length} 个资产图：${missing.join("、")}`,
      `请在“${join(resolve(projectDirectory), "资产图")}”中放入与资产标准名同名的 PNG/JPG/WebP 图片。`,
    ].join("\n"));
  }
  return assets;
}

export async function persistCharacterAsset(
  sourcePath: string,
  projectDirectory: string,
  name: string,
): Promise<string> {
  const source = resolve(sourcePath);
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`角色资产来源不是普通图片文件: ${source}`);
  const extension = extname(source).toLowerCase();
  if (!ASSET_EXTENSIONS.has(extension)) throw new Error(`角色资产图片格式不受支持: ${source}`);

  const directory = join(resolve(projectDirectory), "资产图");
  const stem = characterAssetFileStem(name);
  const destination = join(directory, `${stem}${extension}`);
  if (source.toLocaleLowerCase() === destination.toLocaleLowerCase()) return destination;

  await mkdir(directory, { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await copyFile(source, temporary);
    await rm(destination, { force: true });
    await rename(temporary, destination);
    const entries = await readdir(directory);
    await Promise.all(entries.map(async (entry) => {
      const currentExtension = extname(entry).toLowerCase();
      if (!ASSET_EXTENSIONS.has(currentExtension)) return;
      if (entry.slice(0, -currentExtension.length) !== stem || join(directory, entry) === destination) return;
      await rm(join(directory, entry), { force: true });
    }));
    return destination;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
