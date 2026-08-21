export const PROJECT_ASSET_DIRECTORY_NAME = "资产图";

export function extractAssetNames(prompt: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(/@([\w\u4e00-\u9fff]+)/gu)) {
    const name = match[1]?.trim();
    const key = name?.toLocaleLowerCase();
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function projectAssetDirectoryPath(folderPath: string): string {
  const trimmed = folderPath.trim().replace(/[\\/]+$/u, "");
  const separator = folderPath.includes("\\") ? "\\" : "/";
  return `${trimmed}${separator}${PROJECT_ASSET_DIRECTORY_NAME}`;
}

export function mergeAssetNames(...groups: readonly (readonly string[])[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const value of group) {
      const name = value.trim();
      const key = name.toLocaleLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}
