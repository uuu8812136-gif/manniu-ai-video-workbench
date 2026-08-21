import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/main/database";
import { recoverProjectStoryboardDurations, recoverProjectWorkspaces } from "../src/main/project-workspace";
import { CharacterProfileRepository, ProjectRepository, StoryboardRepository } from "../src/main/repositories";

describe("project workspace recovery", () => {
  const roots: string[] = [];

  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it("adds the asset directory and restores strict character-table profiles", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-tool-project-recovery-"));
    roots.push(root);
    writeFileSync(join(root, "角色表.txt"), [
      "落叶林地",
      "资产 | 场景",
      "一张16:9比例的宽幅图像，秋日林地，纯场景无人物",
    ].join("\n"), "utf8");
    const database = new AppDatabase(":memory:");
    try {
      const projects = new ProjectRepository(database.connection);
      const characterProfiles = new CharacterProfileRepository(database.connection);
      const project = projects.create({ name: "旧项目", folderPath: root });

      const report = recoverProjectWorkspaces(projects, characterProfiles);

      expect(report).toEqual({ initialized: 1, profilesRecovered: 1, warnings: [] });
      expect(existsSync(join(root, "资产图"))).toBe(true);
      expect(projects.get(project.id).rosterPath).toBe(join(root, "角色表.txt"));
      expect(characterProfiles.list(project.id)).toMatchObject([{
        name: "落叶林地",
        assetType: "scene",
        visualPrompt: "一张16:9比例的宽幅图像，秋日林地，纯场景无人物",
      }]);
    } finally {
      database.close();
    }
  });

  it("repairs legacy all-four durations from a matching original CSV", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-tool-duration-recovery-"));
    roots.push(root);
    const csvPath = join(root, "分镜.csv");
    writeFileSync(csvPath, [
      "编号,原声,秒数,画面提示词",
      "1,短镜头,2,近景",
      "2,中等镜头,4,中景",
      "3,较长镜头,5,远景",
    ].join("\r\n"), "utf8");
    const database = new AppDatabase(":memory:");
    try {
      const projects = new ProjectRepository(database.connection);
      const storyboards = new StoryboardRepository(database.connection);
      const project = projects.create({ name: "旧版全四秒项目", folderPath: root, csvPath });
      storyboards.replace(project.id, [
        { index: 0, originalText: "短镜头", prompt: "近景", duration: 4 },
        { index: 1, originalText: "中等镜头", prompt: "中景", duration: 4 },
        { index: 2, originalText: "较长镜头", prompt: "远景", duration: 4 },
      ]);

      const report = await recoverProjectStoryboardDurations(projects, storyboards);

      expect(report).toEqual({ projectsChecked: 1, projectsRecovered: 1, storyboardsRecovered: 2, warnings: [] });
      expect(storyboards.list(project.id).map((storyboard) => storyboard.duration)).toEqual([2, 4, 5]);
    } finally {
      database.close();
    }
  });
});
