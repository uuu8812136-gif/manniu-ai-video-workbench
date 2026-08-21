import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNamedProjectDirectory,
  ensureProjectDirectory,
  initializeProjectWorkspace,
  safeProjectDirectoryName,
  validateProjectCreationPaths,
  validateProjectMaterialPaths,
} from "../src/main/project-creation";

describe("project creation path validation", () => {
  const roots: string[] = [];

  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it("returns normalized existing project material paths", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-tool-project-"));
    roots.push(root);
    const project = join(root, "project");
    const subtitle = join(root, "voice.srt");
    const audio = join(root, "voice.mp3");
    mkdirSync(project);
    writeFileSync(subtitle, "1\n00:00:00,000 --> 00:00:01,000\n测试\n");
    writeFileSync(audio, "audio");

    expect(validateProjectCreationPaths({ folderPath: project, subtitlePath: subtitle, audioPath: audio })).toEqual({
      folderPath: resolve(project),
      subtitlePath: resolve(subtitle),
      audioPath: resolve(audio),
    });
  });

  it("rejects missing and unsupported materials", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-tool-project-"));
    roots.push(root);
    const subtitle = join(root, "voice.txt");
    const audio = join(root, "voice.mp3");
    writeFileSync(subtitle, "text");
    writeFileSync(audio, "audio");

    expect(() => validateProjectCreationPaths({ folderPath: root, subtitlePath: subtitle, audioPath: audio }))
      .toThrow("字幕文件格式不受支持");
    expect(() => validateProjectCreationPaths({ folderPath: root, subtitlePath: join(root, "missing.srt"), audioPath: audio }))
      .toThrow("字幕文件不存在或无法读取");
  });

  it("creates the default project directory and validates materials without a custom directory", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-tool-project-"));
    roots.push(root);
    const subtitle = join(root, "voice.srt");
    const audio = join(root, "voice.mp3");
    writeFileSync(subtitle, "subtitle");
    writeFileSync(audio, "audio");

    expect(ensureProjectDirectory(join(root, "project-9"))).toBe(resolve(root, "project-9"));
    expect(validateProjectMaterialPaths({ subtitlePath: subtitle, audioPath: audio })).toEqual({
      subtitlePath: resolve(subtitle),
      audioPath: resolve(audio),
    });
  });

  it("creates safe project-name directories and allocates deterministic duplicate suffixes", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-tool-project-name-"));
    roots.push(root);

    expect(safeProjectDirectoryName('  CON  ')).toBe("_CON");
    expect(safeProjectDirectoryName('章节一：开场<>"/\\|?*. ')).toBe("章节一：开场________");
    const first = createNamedProjectDirectory(root, "同名项目");
    const second = createNamedProjectDirectory(root, "同名项目");
    expect(first).toBe(resolve(root, "同名项目"));
    expect(second).toBe(resolve(root, "同名项目 (2)"));
    expect(existsSync(join(first, "资产图"))).toBe(true);
    expect(existsSync(join(second, "资产图"))).toBe(true);
  });

  it("initializes an existing custom project directory with the asset folder", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-tool-project-workspace-"));
    roots.push(root);

    expect(initializeProjectWorkspace(root)).toBe(resolve(root));
    expect(existsSync(join(root, "资产图"))).toBe(true);
  });

  it("rejects an asset path occupied by a file", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-tool-project-workspace-conflict-"));
    roots.push(root);
    writeFileSync(join(root, "资产图"), "conflict", "utf8");

    expect(() => initializeProjectWorkspace(root)).toThrow("资产图路径必须是文件夹");
  });
});
