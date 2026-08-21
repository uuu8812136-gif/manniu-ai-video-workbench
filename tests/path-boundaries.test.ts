import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase, sqliteFilePath } from "../src/main/database";
import { writeCsvFileAtomic, readCsvFile, writeTextFileAtomic, readTextFile } from "../src/main/file-workflows";
import { persistGeneratedImage } from "../src/main/image-assets";
import { importLegacyDatabase } from "../src/main/legacy-import";
import { ProjectRepository, StoryboardRepository } from "../src/main/repositories";
import { AsyncVideoTaskClient } from "../src/main/video-client";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "ascii"), Buffer.alloc(2_036, 3)]);

async function deepDirectory(root: string, minimumLength = 300): Promise<string> {
  let current = root;
  let index = 0;
  while (current.length < minimumLength) {
    current = join(current, `中文 长路径层级 ${index}-${"甲".repeat(32)}`);
    index += 1;
  }
  await mkdir(current, { recursive: true });
  return current;
}

function createLegacyDatabase(filePath: string): void {
  const database = new BetterSqlite3(sqliteFilePath(filePath));
  database.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, csv_path TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, folder_path TEXT NOT NULL DEFAULT '',
      subtitle_path TEXT NOT NULL DEFAULT '', audio_path TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, idx INTEGER NOT NULL,
      original_text TEXT NOT NULL DEFAULT '', subjects TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '', duration INTEGER NOT NULL DEFAULT 4,
      status TEXT NOT NULL DEFAULT 'pending', task_id TEXT, video_path TEXT,
      submit_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  database.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    7, "旧库 中文项目", "分镜 导入.csv", "2026-01-01", "2026-01-01", filePath, "字幕.srt", "旁白.wav",
  );
  database.close();
}

describe("Windows long path boundaries", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "AI工具 长路径验收 "));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("persists database, project, storyboard, and legacy import beyond MAX_PATH", async () => {
    const directory = await deepDirectory(root);
    const databasePath = join(directory, "工作数据库 文件.db");
    const legacyPath = join(directory, "旧版数据库 导入.db");
    expect(databasePath.length).toBeGreaterThan(260);

    const database = new AppDatabase(databasePath);
    const projects = new ProjectRepository(database.connection);
    const storyboards = new StoryboardRepository(database.connection);
    const projectFolder = join(directory, "项目 空格", "媒体素材");
    const project = projects.create({ name: "长期 中文项目", folderPath: projectFolder });
    storyboards.replace(project.id, [{ index: 0, originalText: "长路径分镜", prompt: "雨夜街道" }]);
    database.close();

    const reopened = new AppDatabase(databasePath);
    expect(new ProjectRepository(reopened.connection).get(project.id).folderPath).toBe(projectFolder);
    createLegacyDatabase(legacyPath);
    const report = importLegacyDatabase(legacyPath, reopened);
    expect(report.imported.projects).toBe(1);
    expect(new ProjectRepository(reopened.connection).list().map((item) => item.name)).toContain("旧库 中文项目");
    reopened.close();
  });

  it("imports and atomically exports Chinese text and CSV beyond MAX_PATH", async () => {
    const directory = await deepDirectory(root);
    const textPath = join(directory, "导入 文稿.txt");
    const csvPath = join(directory, "导出 分镜.csv");
    expect(csvPath.length).toBeGreaterThan(260);

    await writeTextFileAtomic(textPath, "第一章\n纯本地长路径", { bom: true });
    expect(await readTextFile(textPath)).toMatchObject({ text: "第一章\n纯本地长路径", encoding: "utf-8" });
    await writeCsvFileAtomic(csvPath, [{ 镜号: "1", 文案: "中文，带空格", 提示词: "雨夜\n街道" }], {
      columns: ["镜号", "文案", "提示词"],
    });
    expect((await readCsvFile(csvPath)).rows).toEqual([{ 镜号: "1", 文案: "中文，带空格", 提示词: "雨夜\n街道" }]);
    expect((await readFile(csvPath, "utf8")).startsWith("\ufeff")).toBe(true);
  });

  it("atomically lands generated image and video files beyond MAX_PATH", async () => {
    const directory = await deepDirectory(root);
    const outputDirectory = join(directory, "项目 媒体落盘", "生成结果");
    expect(outputDirectory.length).toBeGreaterThan(260);

    const imagePath = await persistGeneratedImage({
      image: { base64: PNG.toString("base64"), mimeType: "image/png", url: null, revisedPrompt: null },
      outputDirectory,
      stem: "分镜 001",
    });
    const client = new AsyncVideoTaskClient({
      baseUrl: "http://127.0.0.1:9/v1",
      fetch: async () => new Response(MP4, { status: 200, headers: { "content-type": "video/mp4" } }),
    });
    const video = await client.downloadResult("http://127.0.0.1:9/result.mp4", {
      outputDirectory,
      stem: "分镜 001",
    });

    expect(imagePath.length).toBeGreaterThan(260);
    expect(video.path.length).toBeGreaterThan(260);
    expect(existsSync(imagePath)).toBe(true);
    expect(await readFile(imagePath)).toEqual(PNG);
    expect(await readFile(video.path)).toEqual(MP4);
  });
});
