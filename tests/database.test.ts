import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/main/database";
import {
  CharacterProfileRepository,
  ProjectRepository,
  SettingsRepository,
  StoryboardRepository,
  ViduAccountRepository,
} from "../src/main/repositories";

describe("local data repositories", () => {
  let database: AppDatabase;
  let projects: ProjectRepository;
  let characterProfiles: CharacterProfileRepository;
  let storyboards: StoryboardRepository;
  let settings: SettingsRepository;

  beforeEach(() => {
    database = new AppDatabase(":memory:");
    projects = new ProjectRepository(database.connection);
    characterProfiles = new CharacterProfileRepository(database.connection);
    storyboards = new StoryboardRepository(database.connection);
    settings = new SettingsRepository(database.connection);
  });

  afterEach(() => database.close());

  it("creates, updates and deletes a project", () => {
    const created = projects.create({
      name: "测试项目",
      folderPath: "D:\\项目 01",
      rosterPath: "D:\\项目 01\\角色表.txt",
    });
    expect(created.name).toBe("测试项目");
    expect(created.folderPath).toBe("D:\\项目 01");
    expect(created.rosterPath).toBe("D:\\项目 01\\角色表.txt");

    const updated = projects.update(created.id, { name: "正式项目", audioPath: "D:\\素材\\旁白.wav" });
    expect(updated.name).toBe("正式项目");
    expect(updated.audioPath).toContain("旁白.wav");

    projects.delete(created.id);
    expect(projects.list()).toEqual([]);
  });

  it("replaces storyboards atomically and cascades project deletion", () => {
    const project = projects.create({ name: "分镜项目" });
    const inserted = storyboards.replace(project.id, [
      { index: 0, originalText: "第一幕", subjects: ["主角"], prompt: "清晨街道", duration: 4 },
      { index: 1, originalText: "第二幕", subjects: ["主角", "朋友"], prompt: "室内对话", duration: 6 },
    ]);
    expect(inserted).toHaveLength(2);
    expect(inserted[1].subjects).toEqual(["主角", "朋友"]);

    const changed = storyboards.update(inserted[0].id, { status: "done", prompt: "雨后清晨街道" });
    expect(changed.status).toBe("done");
    expect(changed.prompt).toBe("雨后清晨街道");

    projects.delete(project.id);
    expect(storyboards.list(project.id)).toEqual([]);
  });

  it("upserts matching indexes in place and removes indexes missing from the replacement", () => {
    const project = projects.create({ name: "原位覆盖项目" });
    const [kept, removed] = storyboards.replace(project.id, [
      { index: 0, originalText: "旧第一镜", subjects: ["旧角色"], prompt: "旧画面", duration: 4 },
      { index: 2, originalText: "旧第三镜", prompt: "旧画面三", duration: 4 },
    ]);
    storyboards.update(kept.id, {
      status: "done",
      imagePaths: ["D:\\项目\\旧图片.png"],
      videoPath: "D:\\项目\\旧视频.mp4",
    });
    storyboards.appendEvent(kept.id, { eventType: "before_import", message: "历史事件" });

    const replaced = storyboards.replace(project.id, [
      { index: 0, originalText: "新第一镜", subjects: ["新角色"], prompt: "新画面", duration: 6 },
      { index: 5, originalText: "新第六镜", prompt: "新画面六", duration: 4 },
    ]);

    expect(replaced).toHaveLength(2);
    expect(replaced[0]).toMatchObject({
      id: kept.id,
      index: 0,
      originalText: "新第一镜",
      subjects: ["新角色"],
      prompt: "新画面",
      duration: 6,
      status: "pending",
      taskId: null,
      videoTaskId: null,
      videoPath: null,
      imagePaths: [],
      submitCount: 0,
    });
    expect(replaced[1]).toMatchObject({ index: 5, originalText: "新第六镜" });
    expect(() => storyboards.get(removed.id)).toThrow(/分镜不存在/);
    expect(storyboards.events(kept.id)).toMatchObject([{ eventType: "before_import", message: "历史事件" }]);
  });

  it("persists selected visual media on a storyboard", () => {
    const project = projects.create({ name: "媒体项目" });
    const [storyboard] = storyboards.replace(project.id, [
      { index: 0, originalText: "第一幕", duration: 4 },
    ]);

    const withImage = storyboards.update(storyboard.id, {
      imagePaths: ["D:\\素材 目录\\画面一.png"],
      videoPath: null,
    });
    expect(withImage.imagePaths).toEqual(["D:\\素材 目录\\画面一.png"]);
    expect(withImage.videoPath).toBeNull();

    const withVideo = storyboards.update(storyboard.id, {
      imagePaths: [],
      videoPath: "D:\\素材 目录\\镜头一.mp4",
    });
    expect(withVideo.imagePaths).toEqual([]);
    expect(withVideo.videoPath).toBe("D:\\素材 目录\\镜头一.mp4");
  });

  it("persists and resolves character, scene, and special-space profiles", () => {
    const project = projects.create({ name: "资产档案项目" });
    const inserted = characterProfiles.replace(project.id, [
      {
        name: "李明",
        aliases: ["小李", "明哥"],
        identity: "男主角",
        visualPrompt: "黑发青年，深色风衣",
        assetType: "character",
      },
      {
        name: "北境旧城",
        aliases: ["旧城"],
        visualPrompt: "覆雪的古代边城",
        assetType: "scene",
      },
      {
        name: "镜中秘境",
        aliases: ["秘境"],
        visualPrompt: "镜面延伸形成的异空间",
        assetType: "special-space",
      },
    ]);

    expect(inserted.map(({ name, assetType }) => ({ name, assetType }))).toEqual([
      { name: "李明", assetType: "character" },
      { name: "北境旧城", assetType: "scene" },
      { name: "镜中秘境", assetType: "special-space" },
    ]);
    expect(characterProfiles.resolve(project.id, ["小李", "旧城", "镜中秘境", "小李"]).map(({ name }) => name))
      .toEqual(["李明", "北境旧城", "镜中秘境"]);

    const updated = characterProfiles.update(inserted[0].id, {
      aliases: ["阿明"],
      prompt: "李明人物设定图，正面全身",
    });
    expect(updated).toMatchObject({ aliases: ["阿明"], prompt: "李明人物设定图，正面全身" });
    expect(characterProfiles.resolve(project.id, ["小李"])).toEqual([]);
    expect(characterProfiles.resolve(project.id, ["阿明"])).toMatchObject([{ id: inserted[0].id }]);

    characterProfiles.delete(inserted[1].id);
    expect(characterProfiles.list(project.id).map(({ name }) => name)).toEqual(["李明", "镜中秘境"]);
    projects.delete(project.id);
    expect(characterProfiles.list(project.id)).toEqual([]);
  });

  it("keeps image and video provider task state isolated", () => {
    const project = projects.create({ name: "Concurrent media project" });
    const [storyboard] = storyboards.replace(project.id, [
      { index: 0, originalText: "Scene one", prompt: "A city street", duration: 4 },
    ]);

    storyboards.markImageJob(storyboard.id, "generating", "image-job");
    storyboards.saveVideoProviderTask(storyboard.id, "video-provider");
    const withVideo = storyboards.attachGeneratedVideo(storyboard.id, "D:\\output\\scene.mp4");

    expect(withVideo).toMatchObject({
      status: "done",
      taskId: "image-job",
      videoTaskId: null,
      videoPath: "D:\\output\\scene.mp4",
      submitCount: 1,
    });

    const withImage = storyboards.attachGeneratedImage(storyboard.id, "D:\\output\\scene.png", "image-job");
    expect(withImage).toMatchObject({
      status: "done",
      taskId: "image-job",
      videoTaskId: null,
      videoPath: "D:\\output\\scene.mp4",
      imagePaths: ["D:\\output\\scene.png"],
      submitCount: 2,
    });
  });

  it("upgrades an existing v1 database without reusing the image task id for video", () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-tool-v1-upgrade-"));
    const filePath = join(directory, "v1.db");
    const old = new BetterSqlite3(filePath);
    old.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-01-01');
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        folder_path TEXT NOT NULL DEFAULT '',
        csv_path TEXT NOT NULL DEFAULT '',
        subtitle_path TEXT NOT NULL DEFAULT '',
        audio_path TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE storyboards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        original_text TEXT NOT NULL DEFAULT '',
        subjects_json TEXT NOT NULL DEFAULT '[]',
        prompt TEXT NOT NULL DEFAULT '',
        duration INTEGER NOT NULL DEFAULT 4,
        status TEXT NOT NULL DEFAULT 'pending',
        task_id TEXT,
        video_path TEXT,
        image_paths_json TEXT NOT NULL DEFAULT '[]',
        submit_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        input_json TEXT NOT NULL DEFAULT '{}',
        output_json TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO projects(id, name, created_at, updated_at)
      VALUES (1, 'Existing project', '2026-01-01', '2026-01-01');
      INSERT INTO storyboards(
        id, project_id, idx, original_text, prompt, status, task_id, updated_at
      ) VALUES (1, 1, 0, 'Existing scene', 'Existing prompt', 'generating', 'image-existing', '2026-01-01');
    `);
    old.close();

    let upgraded: AppDatabase | null = null;
    try {
      upgraded = new AppDatabase(filePath);
      const migrated = new StoryboardRepository(upgraded.connection).get(1);
      const columns = upgraded.connection.prepare("PRAGMA table_info(storyboards)").all() as Array<{ name: string }>;
      const projectColumns = upgraded.connection.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      const characterColumns = upgraded.connection.prepare("PRAGMA table_info(character_profiles)").all() as Array<{ name: string }>;
      const versions = upgraded.connection
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;

      expect(columns.map(({ name }) => name)).toContain("video_task_id");
      expect(projectColumns.map(({ name }) => name)).toContain("roster_path");
      expect(characterColumns.map(({ name }) => name)).toEqual(expect.arrayContaining(["asset_type", "visual_prompt", "aliases_json"]));
      expect(versions.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(migrated).toMatchObject({ taskId: "image-existing", videoTaskId: null });
      expect(new ProjectRepository(upgraded.connection).get(1)).toMatchObject({ rosterPath: "" });
    } finally {
      upgraded?.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("rolls back the entire replacement when one storyboard is invalid", () => {
    const project = projects.create({ name: "事务项目" });
    storyboards.replace(project.id, [{ index: 0, originalText: "保留内容" }]);

    expect(() =>
      storyboards.replace(project.id, [
        { index: 0, originalText: "新内容一" },
        { index: 0, originalText: "重复序号" },
      ]),
    ).toThrow();

    expect(storyboards.list(project.id).map((item) => item.originalText)).toEqual(["保留内容"]);
  });

  it("persists settings without exposing a separate schema", () => {
    settings.set("infer_api_base_url", "http://127.0.0.1:11434/v1");
    settings.set("infer_model", "local-model");
    expect(settings.get("infer_api_base_url")).toBe("http://127.0.0.1:11434/v1");
    expect(settings.list()).toMatchObject({ infer_model: "local-model" });
  });

  it("refuses to delete a Vidu account while persisted work still owns its session", () => {
    const accounts = new ViduAccountRepository(database.connection);
    const account = accounts.create("生成账号");
    const project = projects.create({ name: "账号归属项目" });
    const [storyboard] = storyboards.replace(project.id, [
      { index: 0, originalText: "第一镜", prompt: "远端任务" },
    ]);
    storyboards.beginVideoSubmission(storyboard.id, "vidu-browser", account.id);

    expect(() => accounts.assertCanDelete(account.id)).toThrow(/仍有未完成或待确认的视频任务/);
    expect(() => accounts.delete(account.id)).toThrow(/仍有未完成或待确认的视频任务/);
    expect(accounts.get(account.id).id).toBe(account.id);

    storyboards.clearVideoProviderTask(storyboard.id);
    expect(accounts.assertCanDelete(account.id)).toMatchObject({ id: account.id });
    accounts.delete(account.id);
    expect(accounts.list()).toEqual([]);
    expect(storyboards.get(storyboard.id).videoAccountId).toBeNull();
  });

  it("reopens a database from a Chinese path without losing data", () => {
    database.close();
    const directory = mkdtempSync(join(tmpdir(), "AI工具 离线-"));
    const filePath = join(directory, "工作区.db");
    try {
      const first = new AppDatabase(filePath);
      new ProjectRepository(first.connection).create({ name: "长期项目", folderPath: join(directory, "素材 01") });
      first.close();

      const reopened = new AppDatabase(filePath);
      expect(new ProjectRepository(reopened.connection).list()).toMatchObject([
        { name: "长期项目", folderPath: join(directory, "素材 01") },
      ]);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
      database = new AppDatabase(":memory:");
    }
  });
});
