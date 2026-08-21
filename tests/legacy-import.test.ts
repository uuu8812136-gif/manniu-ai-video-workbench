import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/main/database";
import {
  importLegacyDatabase,
  isSensitiveLegacySetting,
  legacyImportMarkerKey,
  mapLegacySettingKey,
} from "../src/main/legacy-import";

function createLegacyDatabase(filePath: string): BetterSqlite3.Database {
  const db = new BetterSqlite3(filePath);
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      csv_path TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      folder_path TEXT NOT NULL DEFAULT '',
      subtitle_path TEXT NOT NULL DEFAULT '',
      audio_path TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      original_text TEXT NOT NULL DEFAULT '',
      subjects TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      duration INTEGER NOT NULL DEFAULT 4,
      status TEXT NOT NULL DEFAULT 'pending',
      task_id TEXT,
      video_path TEXT,
      submit_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

function digest(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

describe("legacy database import", () => {
  let directory: string;
  let sourcePath: string;
  let target: AppDatabase;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ai-tool-legacy-import-"));
    sourcePath = join(directory, "database.db");
    target = new AppDatabase(join(directory, "offline.db"));
  });

  afterEach(() => {
    target.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("dry-runs without changing either database", () => {
    const legacy = createLegacyDatabase(sourcePath);
    legacy.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      9,
      "Novel 9",
      "D:\\old\\shots.csv",
      "2025-01-01T00:00:00.000Z",
      "2025-01-02T00:00:00.000Z",
      "D:\\old",
      "",
      "",
    );
    legacy.prepare("INSERT INTO storyboards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      1,
      9,
      0,
      "First scene",
      '["Alice","Bob"]',
      "A rainy street",
      6,
      "done",
      "task-old",
      "D:\\old\\scene.mp4",
      2,
    );
    legacy.prepare("INSERT INTO settings VALUES (?, ?)").run("infer_model", "local-model");
    legacy.close();
    const before = digest(sourcePath);

    const report = importLegacyDatabase(sourcePath, target, { dryRun: true });

    expect(report).toMatchObject({
      dryRun: true,
      alreadyImported: false,
      scanned: { projects: 1, storyboards: 1, settings: 1 },
      wouldImport: { projects: 1, storyboards: 1, settings: 1 },
      imported: { projects: 0, storyboards: 0, settings: 0 },
    });
    expect(target.connection.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 0 });
    expect(target.connection.prepare("SELECT COUNT(*) AS count FROM settings").get()).toEqual({ count: 0 });
    expect(digest(sourcePath)).toBe(before);
  });

  it("rejects an unrelated SQLite file during preview", () => {
    const unrelated = new BetterSqlite3(sourcePath);
    unrelated.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, value TEXT)");
    unrelated.close();

    expect(() => importLegacyDatabase(sourcePath, target, { dryRun: true })).toThrow(
      "not a recognized legacy database",
    );
    expect(target.connection.prepare("SELECT COUNT(*) AS count FROM settings").get()).toEqual({ count: 0 });
  });

  it("maps project ids, adapts legacy storyboard fields, and leaves the source read-only", () => {
    const legacy = createLegacyDatabase(sourcePath);
    legacy.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      42,
      "Imported novel",
      "shots.csv",
      "2025-02-01T00:00:00.000Z",
      "2025-02-02T00:00:00.000Z",
      "D:\\legacy project",
      "subtitles.srt",
      "voice.wav",
    );
    legacy.prepare("INSERT INTO storyboards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      7,
      42,
      3,
      "The door opens",
      "Alice，Bob",
      "Interior, warm light",
      0,
      "unknown-old-status",
      null,
      "clip.mp4",
      -3,
    );
    legacy.prepare("INSERT INTO settings VALUES (?, ?)").run("infer_model", "legacy-model");
    legacy.close();
    target.connection
      .prepare("INSERT INTO projects(name, created_at, updated_at) VALUES (?, ?, ?)")
      .run("Existing", "2026-01-01", "2026-01-01");
    const before = digest(sourcePath);

    const report = importLegacyDatabase(sourcePath, target, { now: () => "2026-07-26T00:00:00.000Z" });
    const newProjectId = report.projectIdMap["42"];

    expect(newProjectId).toBe(2);
    expect(report.imported).toEqual({ projects: 1, storyboards: 1, settings: 1 });
    expect(target.connection.prepare("SELECT * FROM projects WHERE id = ?").get(newProjectId)).toMatchObject({
      name: "Imported novel",
      folder_path: "D:\\legacy project",
      csv_path: "shots.csv",
      subtitle_path: "subtitles.srt",
      audio_path: "voice.wav",
    });
    expect(target.connection.prepare("SELECT * FROM storyboards WHERE project_id = ?").get(newProjectId)).toMatchObject({
      idx: 3,
      subjects_json: '["Alice","Bob"]',
      duration: 4,
      status: "pending",
      video_path: "clip.mp4",
      image_paths_json: "[]",
      submit_count: 0,
    });
    expect(digest(sourcePath)).toBe(before);
  });

  it("never imports credentials, passwords, JWTs, tokens, API keys, or nested secrets", () => {
    const legacy = createLegacyDatabase(sourcePath);
    const entries = [
      ["saved_credentials_api_key", '{"username":"u","password":"plain-password"}'],
      ["infer_api_key", "sk-this-must-not-leak"],
      ["admin_password", "plain-password"],
      ["vidu_jwt", "jwt-secret"],
      ["access-token", "token-secret"],
      ["refreshToken", "camel-case-secret"],
      ["thirdPartyApiKey", "camel-case-api-key"],
      ["login_state", '{"profile":"u","token":"nested-secret"}'],
      ["session_state", "eyJheader.payload.signature"],
      ["infer_api_base_url", "http://127.0.0.1:11434/v1"],
      ["infer_model", "local-model"],
    ] as const;
    const insert = legacy.prepare("INSERT INTO settings VALUES (?, ?)");
    entries.forEach((entry) => insert.run(...entry));
    legacy.close();

    const report = importLegacyDatabase(sourcePath, target);
    const importedSettings = target.connection
      .prepare("SELECT key, value FROM settings WHERE key NOT LIKE 'legacy_import_v1_%' ORDER BY key")
      .all();

    expect(report.skipped.sensitiveSettings).toBe(9);
    expect(importedSettings).toEqual([
      { key: "infer_api_base_url", value: "http://127.0.0.1:11434/v1" },
      { key: "infer_model", value: "local-model" },
    ]);
    expect(JSON.stringify(importedSettings)).not.toContain("secret");
    expect(isSensitiveLegacySetting("custom", '{"password":"x"}')).toBe(true);
    expect(isSensitiveLegacySetting("output_dir", "D:\\output")).toBe(false);
  });

  it("maps the four original output directory keys to the current settings contract", () => {
    const legacy = createLegacyDatabase(sourcePath);
    const entries = [
      ["imagegen_save_dir", "D:\\legacy\\images"],
      ["infer_save_dir", "D:\\legacy\\inference"],
      ["novel_opt_save_dir", "D:\\legacy\\opening"],
      ["text_polish_save_dir", "D:\\legacy\\polish"],
    ] as const;
    const insert = legacy.prepare("INSERT INTO settings VALUES (?, ?)");
    entries.forEach((entry) => insert.run(...entry));
    legacy.close();

    const report = importLegacyDatabase(sourcePath, target);
    const settings = target.connection
      .prepare("SELECT key, value FROM settings WHERE key NOT LIKE 'legacy_import_v1_%' ORDER BY key")
      .all();

    expect(report.imported.settings).toBe(4);
    expect(settings).toEqual([
      { key: "imagegen_output_dir", value: "D:\\legacy\\images" },
      { key: "infer_output_dir", value: "D:\\legacy\\inference" },
      { key: "opening_output_dir", value: "D:\\legacy\\opening" },
      { key: "text_polish_output_dir", value: "D:\\legacy\\polish" },
    ]);
    expect(mapLegacySettingKey("infer_save_dir")).toBe("infer_output_dir");
  });

  it("uses an import-once marker and preserves target settings on key conflicts", () => {
    const legacy = createLegacyDatabase(sourcePath);
    legacy.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      1,
      "Only once",
      "",
      "2025-01-01",
      "2025-01-01",
      "",
      "",
      "",
    );
    legacy.prepare("INSERT INTO settings VALUES (?, ?)").run("infer_model", "legacy-model");
    legacy.close();
    target.connection
      .prepare("INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)")
      .run("infer_model", "current-model", "2026-01-01");

    const first = importLegacyDatabase(sourcePath, target);
    const second = importLegacyDatabase(sourcePath, target);

    expect(first.skipped.existingSettings).toBe(1);
    expect(first.imported.settings).toBe(0);
    expect(second.alreadyImported).toBe(true);
    expect(second.imported).toEqual({ projects: 0, storyboards: 0, settings: 0 });
    expect(target.connection.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 1 });
    expect(target.connection.prepare("SELECT value FROM settings WHERE key = 'infer_model'").get()).toEqual({
      value: "current-model",
    });
    expect(target.connection.prepare("SELECT value FROM settings WHERE key = ?").get(legacyImportMarkerKey(sourcePath))).toBeTruthy();
  });

  it("rolls back projects, storyboards, settings, and marker when any insert fails", () => {
    const legacy = createLegacyDatabase(sourcePath);
    legacy.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      3,
      "Rollback project",
      "",
      "2025-01-01",
      "2025-01-01",
      "",
      "",
      "",
    );
    legacy.prepare("INSERT INTO storyboards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      4,
      3,
      0,
      "Rollback scene",
      "[]",
      "prompt",
      4,
      "pending",
      null,
      null,
      0,
    );
    legacy.prepare("INSERT INTO settings VALUES (?, ?)").run("infer_model", "legacy-model");
    legacy.close();
    target.connection.exec(`
      CREATE TRIGGER reject_legacy_storyboard
      BEFORE INSERT ON storyboards
      BEGIN
        SELECT RAISE(ABORT, 'test failure');
      END;
    `);

    expect(() => importLegacyDatabase(sourcePath, target)).toThrow("test failure");
    expect(target.connection.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 0 });
    expect(target.connection.prepare("SELECT COUNT(*) AS count FROM storyboards").get()).toEqual({ count: 0 });
    expect(target.connection.prepare("SELECT COUNT(*) AS count FROM settings").get()).toEqual({ count: 0 });
  });
});
