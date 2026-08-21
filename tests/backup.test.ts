import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_MANIFEST_FILE,
  LAST_RESTORE_FILE,
  PENDING_RESTORE_FILE,
  applyPendingDirectoryRestore,
  createDirectoryBackup,
  currentEncryptionScopeFingerprint,
  preflightDirectoryRestore,
  prepareDirectoryRestore,
  readLastRestoreStatus,
  validateDirectoryBackup,
} from "../src/main/backup";
import { AppDatabase } from "../src/main/database";
import { ProjectRepository, SettingsRepository, StoryboardRepository } from "../src/main/repositories";
import { ENCRYPTED_SETTING_PREFIX, SecureSettingsService, type SecretCodec } from "../src/main/secure-settings";

class FixtureCodec implements SecretCodec {
  isAvailable(): boolean {
    return true;
  }

  encrypt(value: string): string {
    return Buffer.from(`fixture-cipher:${value}`, "utf8").toString("base64");
  }

  decrypt(value: string): string {
    return Buffer.from(value, "base64").toString("utf8").slice("fixture-cipher:".length);
  }
}

type Fixture = {
  database: AppDatabase;
  userData: string;
  projectsPath: string;
  logsPath: string;
  backupRoot: string;
  secret: string;
  encrypted: string;
  scope: string;
};

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("directory backup and restore preflight", () => {
  let root: string;
  const databases: AppDatabase[] = [];

  beforeEach(async () => {
    root = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "ai-tool-backup-"));
  });

  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    await rm(root, { recursive: true, force: true });
  });

  const createFixture = async (): Promise<Fixture> => {
    const userData = join(root, "用户 数据");
    const projectsPath = join(userData, "projects");
    const logsPath = join(userData, "logs");
    const backupRoot = join(root, "备份 输出");
    await mkdir(join(projectsPath, "project-1", "images"), { recursive: true });
    await mkdir(logsPath, { recursive: true });
    await writeFile(join(projectsPath, "project-1", "images", "画面 01.png"), "image-content", "utf8");
    await writeFile(join(logsPath, "runtime.log"), "local log", "utf8");

    const database = new AppDatabase(join(userData, "ai-tool.db"));
    databases.push(database);
    const projects = new ProjectRepository(database.connection);
    projects.create({ name: "备份项目", folderPath: join(projectsPath, "project-1") });
    const storage = new SettingsRepository(database.connection);
    const settings = new SecureSettingsService(storage, new FixtureCodec());
    const secret = "sk-test-must-never-appear-in-report";
    settings.set("infer_api_key", secret);
    settings.set("infer_model", "local-model");
    const encrypted = storage.get("infer_api_key")!;
    const scope = fingerprint("source-windows-user");
    return { database, userData, projectsPath, logsPath, backupRoot, secret, encrypted, scope };
  };

  it("creates a consistent SQLite snapshot with files, manifest and checksums", async () => {
    const fixture = await createFixture();
    const result = await createDirectoryBackup({
      destinationRoot: fixture.backupRoot,
      backupName: "完整 备份",
      database: fixture.database.connection,
      sourcePaths: { projects: fixture.projectsPath, logs: fixture.logsPath },
      includeProjects: true,
      includeLogs: true,
      appVersion: "0.2.0",
      encryptionScopeFingerprint: fixture.scope,
      now: () => new Date("2026-07-26T02:00:00.000Z"),
    });

    expect(result.manifest).toMatchObject({
      format: "ai-tool-directory-backup",
      formatVersion: 2,
      createdAt: "2026-07-26T02:00:00.000Z",
      included: { projects: true, logs: true },
      sqlite: { quickCheck: "ok", schemaVersion: 11 },
      security: {
        protectedSettingCount: 1,
        protectedSettingKeys: ["infer_api_key"],
        crossScopeRequiresReentry: true,
      },
    });
    expect(result.totalFiles).toBe(3);
    expect(result.manifest.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(fixture.secret);
    expect(JSON.stringify(result)).not.toContain(fixture.encrypted);
    expect(JSON.stringify(result)).not.toContain(ENCRYPTED_SETTING_PREFIX);

    const snapshot = new BetterSqlite3(join(result.backupPath, ...result.manifest.sqlite.relativePath.split("/")), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(snapshot.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
      expect(snapshot.prepare("SELECT name FROM projects").get()).toEqual({ name: "备份项目" });
      expect(snapshot.prepare("SELECT value FROM settings WHERE key = 'infer_api_key'").get()).toEqual({
        value: fixture.encrypted,
      });
    } finally {
      snapshot.close();
    }
  });

  it("validates read-only and detects a tampered copied asset", async () => {
    const fixture = await createFixture();
    const result = await createDirectoryBackup({
      destinationRoot: fixture.backupRoot,
      backupName: "tamper-test",
      database: fixture.database.connection,
      sourcePaths: { projects: fixture.projectsPath },
      includeProjects: true,
      encryptionScopeFingerprint: fixture.scope,
    });
    const snapshotPath = join(result.backupPath, ...result.manifest.sqlite.relativePath.split("/"));
    const databaseDirectory = join(result.backupPath, "database");
    const databaseFilesBefore = await readdir(databaseDirectory);
    const databaseMtimeBefore = (await stat(snapshotPath)).mtimeMs;
    const clean = await validateDirectoryBackup(result.backupPath);
    expect(clean.valid).toBe(true);
    expect(clean.database).toMatchObject({ healthy: true, quickCheck: ["ok"], error: null });
    expect(JSON.stringify(clean)).not.toContain(fixture.secret);
    expect(JSON.stringify(clean)).not.toContain(fixture.encrypted);
    expect(await readdir(databaseDirectory)).toEqual(databaseFilesBefore);
    expect((await stat(snapshotPath)).mtimeMs).toBe(databaseMtimeBefore);

    const copiedAsset = join(result.backupPath, "user-data", "projects", "project-1", "images", "画面 01.png");
    await writeFile(copiedAsset, "tampered-content", "utf8");
    const modifiedAt = (await stat(copiedAsset)).mtimeMs;
    const invalid = await validateDirectoryBackup(result.backupPath);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.join("\n")).toMatch(/大小不匹配|SHA-256 不匹配/);
    expect((await stat(copiedAsset)).mtimeMs).toBe(modifiedAt);
  });

  it("warns about database file references outside the copied projects root", async () => {
    const fixture = await createFixture();
    const projects = new ProjectRepository(fixture.database.connection);
    const storyboards = new StoryboardRepository(fixture.database.connection);
    const project = projects.list()[0];
    const externalRoot = join(root, "外部 素材");
    projects.update(project.id, {
      folderPath: join(externalRoot, "project-folder"),
      csvPath: join(externalRoot, "分镜.csv"),
      subtitlePath: join(externalRoot, "字幕.srt"),
      audioPath: join(externalRoot, "旁白.wav"),
    });
    const storyboard = storyboards.create(project.id, { index: 0, originalText: "镜头" });
    storyboards.update(storyboard.id, {
      videoPath: join(externalRoot, "镜头.mp4"),
      imagePaths: [
        join(fixture.projectsPath, "project-1", "images", "画面 01.png"),
        join(externalRoot, "画面 02.png"),
      ],
    });

    const result = await createDirectoryBackup({
      destinationRoot: fixture.backupRoot,
      backupName: "external-reference-test",
      database: fixture.database.connection,
      sourcePaths: { projects: fixture.projectsPath },
      includeProjects: true,
      encryptionScopeFingerprint: fixture.scope,
    });
    const warningText = result.warnings.join("\n");
    expect(warningText).toContain("外部引用未包含在备份中");
    expect(warningText).toContain(join(externalRoot, "project-folder"));
    expect(warningText).toContain(join(externalRoot, "分镜.csv"));
    expect(warningText).toContain(join(externalRoot, "字幕.srt"));
    expect(warningText).toContain(join(externalRoot, "旁白.wav"));
    expect(warningText).toContain(join(externalRoot, "镜头.mp4"));
    expect(warningText).toContain(join(externalRoot, "画面 02.png"));
    expect(warningText).not.toContain(join(fixture.projectsPath, "project-1", "images", "画面 01.png"));
  });

  it("marks DPAPI-bound settings for re-entry across Windows scopes", async () => {
    const fixture = await createFixture();
    const result = await createDirectoryBackup({
      destinationRoot: fixture.backupRoot,
      backupName: "migration-test",
      database: fixture.database.connection,
      encryptionScopeFingerprint: fixture.scope,
    });
    const destinations = {
      database: join(root, "restore", "ai-tool.db"),
      projects: join(root, "restore", "projects"),
      logs: join(root, "restore", "logs"),
    };
    const crossScope = await preflightDirectoryRestore(result.backupPath, {
      currentEncryptionScopeFingerprint: fingerprint("different-windows-user"),
      destinations,
    });
    expect(crossScope.ready).toBe(true);
    expect(crossScope.destinations.every((item) => item.writable)).toBe(true);
    expect(crossScope.security).toMatchObject({
      sourceScopeMatches: false,
      requiresSecretReentry: true,
      protectedSettingCount: 1,
      protectedSettingKeys: ["infer_api_key"],
    });
    expect(crossScope.security.message).toContain("必须重新填写");
    expect(JSON.stringify(crossScope)).not.toContain(fixture.secret);
    expect(JSON.stringify(crossScope)).not.toContain(fixture.encrypted);

    const sameScope = await preflightDirectoryRestore(result.backupPath, {
      currentEncryptionScopeFingerprint: fixture.scope,
    });
    expect(sameScope.security).toMatchObject({ sourceScopeMatches: true, requiresSecretReentry: false });
    expect(sameScope.security.message).toBeNull();
  });

  it("rejects destination paths whose existing type cannot be restored", async () => {
    const fixture = await createFixture();
    const result = await createDirectoryBackup({
      destinationRoot: fixture.backupRoot,
      backupName: "destination-type-test",
      database: fixture.database.connection,
      encryptionScopeFingerprint: fixture.scope,
    });
    const databaseDirectory = join(root, "restore-as-directory");
    const projectsFile = join(root, "restore-projects-file");
    await mkdir(databaseDirectory);
    await writeFile(projectsFile, "not a directory", "utf8");

    const preflight = await preflightDirectoryRestore(result.backupPath, {
      currentEncryptionScopeFingerprint: fixture.scope,
      destinations: { database: databaseDirectory, projects: projectsFile },
    });
    expect(preflight.ready).toBe(false);
    expect(preflight.destinations).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "database", writable: false, error: "数据库恢复目标不能是目录" }),
      expect.objectContaining({ category: "projects", writable: false, error: "projects 恢复目标不能是文件" }),
    ]));
  });

  it("rejects unsafe manifest paths without reading outside the backup", async () => {
    const fixture = await createFixture();
    const result = await createDirectoryBackup({
      destinationRoot: fixture.backupRoot,
      backupName: "unsafe-manifest",
      database: fixture.database.connection,
      encryptionScopeFingerprint: fixture.scope,
    });
    const manifestPath = join(result.backupPath, BACKUP_MANIFEST_FILE);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      entries: Array<{ path: string }>;
    };
    manifest.entries[0].path = "../outside.db";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const validation = await validateDirectoryBackup(result.backupPath);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("\n")).toContain("安全相对路径");
  });

  it("refuses a destination nested under copied source data", async () => {
    const fixture = await createFixture();
    await expect(createDirectoryBackup({
      destinationRoot: join(fixture.projectsPath, "backups"),
      database: fixture.database.connection,
      sourcePaths: { projects: fixture.projectsPath },
      includeProjects: true,
      encryptionScopeFingerprint: fixture.scope,
    })).rejects.toThrow("不能位于 projects 源目录内部");
    expect(await readdir(fixture.projectsPath)).not.toContain("backups");
  });

  it("prepares a restore without touching the live database, then applies it with path migration and secret clearing", async () => {
    const fixture = await createFixture();
    const sourceProjects = new ProjectRepository(fixture.database.connection);
    const sourceStoryboards = new StoryboardRepository(fixture.database.connection);
    const sourceProject = sourceProjects.list()[0];
    sourceProjects.update(sourceProject.id, {
      csvPath: join(fixture.projectsPath, "project-1", "storyboards.csv"),
      subtitlePath: join(fixture.projectsPath, "project-1", "subtitles.srt"),
      audioPath: join(fixture.projectsPath, "project-1", "audio.wav"),
    });
    const sourceStoryboard = sourceStoryboards.create(sourceProject.id, { index: 0, originalText: "恢复镜头" });
    sourceStoryboards.update(sourceStoryboard.id, {
      videoPath: join(fixture.projectsPath, "project-1", "video.mp4"),
      imagePaths: [join(fixture.projectsPath, "project-1", "images", "画面 01.png")],
    });
    const backup = await createDirectoryBackup({
      destinationRoot: fixture.backupRoot,
      backupName: "restore-success",
      database: fixture.database.connection,
      sourcePaths: { projects: fixture.projectsPath, logs: fixture.logsPath },
      includeProjects: true,
      includeLogs: true,
      encryptionScopeFingerprint: fixture.scope,
    });

    const targetUserData = join(root, "目标 用户数据");
    const paths = {
      userData: targetUserData,
      database: join(targetUserData, "ai-tool.db"),
      projects: join(targetUserData, "projects"),
      logs: join(targetUserData, "logs"),
    };
    await mkdir(paths.projects, { recursive: true });
    await mkdir(paths.logs, { recursive: true });
    await writeFile(join(paths.projects, "current.txt"), "current-project", "utf8");
    const current = new AppDatabase(paths.database);
    new ProjectRepository(current.connection).create({ name: "当前数据" });
    current.close();

    const prepared = await prepareDirectoryRestore(backup.backupPath, {
      paths,
      currentEncryptionScopeFingerprint: fingerprint("different-windows-user"),
      now: () => new Date("2026-07-26T03:00:00.000Z"),
    });
    expect(prepared).toMatchObject({
      restartRequired: true,
      requiresSecretReentry: true,
      clearedSettingKeys: ["infer_api_key"],
    });
    expect(prepared.rewrittenPathCount).toBeGreaterThanOrEqual(6);
    expect(await readFile(join(targetUserData, PENDING_RESTORE_FILE), "utf8")).toContain(prepared.restoreId);
    const beforeApply = new BetterSqlite3(paths.database, { readonly: true });
    expect(beforeApply.prepare("SELECT name FROM projects").get()).toEqual({ name: "当前数据" });
    beforeApply.close();

    const status = await applyPendingDirectoryRestore({
      paths,
      now: () => new Date("2026-07-26T03:01:00.000Z"),
    });
    expect(status?.status, status?.message).toBe("applied");
    expect(status?.requiresSecretReentry).toBe(true);
    expect(status?.rollbackPath).toBeTruthy();
    const restored = new BetterSqlite3(paths.database, { readonly: true });
    try {
      expect(restored.prepare("SELECT name, folder_path, csv_path, subtitle_path, audio_path FROM projects").get()).toEqual({
        name: "备份项目",
        folder_path: join(paths.projects, "project-1"),
        csv_path: join(paths.projects, "project-1", "storyboards.csv"),
        subtitle_path: join(paths.projects, "project-1", "subtitles.srt"),
        audio_path: join(paths.projects, "project-1", "audio.wav"),
      });
      expect(restored.prepare("SELECT value FROM settings WHERE key = 'infer_api_key'").get()).toEqual({ value: "" });
      const storyboard = restored.prepare("SELECT video_path, image_paths_json FROM storyboards").get() as {
        video_path: string;
        image_paths_json: string;
      };
      expect(storyboard.video_path).toBe(join(paths.projects, "project-1", "video.mp4"));
      expect(JSON.parse(storyboard.image_paths_json)).toEqual([
        join(paths.projects, "project-1", "images", "画面 01.png"),
      ]);
    } finally {
      restored.close();
    }
    expect(await readFile(join(paths.projects, "project-1", "images", "画面 01.png"), "utf8")).toBe("image-content");
    await expect(stat(join(targetUserData, PENDING_RESTORE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readLastRestoreStatus(targetUserData)).toMatchObject({ status: "applied" });
    expect(await readFile(join(targetUserData, LAST_RESTORE_FILE), "utf8")).not.toContain(fixture.secret);
  });

  it("rolls all installed targets back when a staged category replacement fails", async () => {
    const fixture = await createFixture();
    const backup = await createDirectoryBackup({
      destinationRoot: fixture.backupRoot,
      backupName: "restore-rollback",
      database: fixture.database.connection,
      sourcePaths: { projects: fixture.projectsPath, logs: fixture.logsPath },
      includeProjects: true,
      includeLogs: true,
      encryptionScopeFingerprint: fixture.scope,
    });
    const targetUserData = join(root, "rollback target");
    const paths = {
      userData: targetUserData,
      database: join(targetUserData, "ai-tool.db"),
      projects: join(targetUserData, "projects"),
      logs: join(targetUserData, "logs"),
    };
    await mkdir(paths.projects, { recursive: true });
    await mkdir(paths.logs, { recursive: true });
    await writeFile(join(paths.projects, "current.txt"), "keep-project", "utf8");
    await writeFile(join(paths.logs, "current.log"), "keep-log", "utf8");
    const current = new AppDatabase(paths.database);
    new ProjectRepository(current.connection).create({ name: "必须回滚" });
    current.close();
    await prepareDirectoryRestore(backup.backupPath, {
      paths,
      currentEncryptionScopeFingerprint: fixture.scope,
    });

    const status = await applyPendingDirectoryRestore({
      paths,
      renamePath: async (source, destination) => {
        const sourcePath = String(source);
        if (sourcePath.includes("ai-tool-restore-new") && String(destination) === paths.projects) {
          throw new Error("injected projects replacement failure");
        }
        await rename(source, destination);
      },
    });
    expect(status).toMatchObject({ status: "failed" });
    expect(status?.message).toContain("原数据已回滚");
    const rolledBack = new BetterSqlite3(paths.database, { readonly: true });
    expect(rolledBack.prepare("SELECT name FROM projects").get()).toEqual({ name: "必须回滚" });
    rolledBack.close();
    expect(await readFile(join(paths.projects, "current.txt"), "utf8")).toBe("keep-project");
    expect(await readFile(join(paths.logs, "current.log"), "utf8")).toBe("keep-log");
    await expect(stat(join(targetUserData, PENDING_RESTORE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects an interrupted replacement on startup and restores the rollback copy", async () => {
    const fixture = await createFixture();
    const backup = await createDirectoryBackup({
      destinationRoot: fixture.backupRoot,
      backupName: "interrupted-restore",
      database: fixture.database.connection,
      sourcePaths: { projects: fixture.projectsPath },
      includeProjects: true,
      encryptionScopeFingerprint: fixture.scope,
    });
    const targetUserData = join(root, "interrupted target");
    const paths = {
      userData: targetUserData,
      database: join(targetUserData, "ai-tool.db"),
      projects: join(targetUserData, "projects"),
      logs: join(targetUserData, "logs"),
    };
    await mkdir(paths.projects, { recursive: true });
    const current = new AppDatabase(paths.database);
    new ProjectRepository(current.connection).create({ name: "中断前数据" });
    current.close();
    const prepared = await prepareDirectoryRestore(backup.backupPath, {
      paths,
      currentEncryptionScopeFingerprint: fixture.scope,
    });
    const stagingRoot = join(targetUserData, ".restore-staging", prepared.restoreId);
    const swapDatabase = join(targetUserData, `.ai-tool.db.ai-tool-restore-new-${prepared.restoreId}`);
    const swapProjects = join(targetUserData, `.projects.ai-tool-restore-new-${prepared.restoreId}`);
    const rollbackDatabase = join(targetUserData, `.ai-tool.db.ai-tool-restore-rollback-${prepared.restoreId}`);
    await (await import("node:fs/promises")).copyFile(join(stagingRoot, "database", "restored.db"), swapDatabase);
    await cp(join(stagingRoot, "projects"), swapProjects, { recursive: true });
    await rename(paths.database, rollbackDatabase);
    await rename(swapDatabase, paths.database);
    await writeFile(join(stagingRoot, "replacement-started"), JSON.stringify({ restoreId: prepared.restoreId }), "utf8");

    const status = await applyPendingDirectoryRestore({ paths });
    expect(status).toMatchObject({ status: "failed" });
    expect(status?.message).toContain("已自动回滚");
    const restoredOriginal = new BetterSqlite3(paths.database, { readonly: true });
    expect(restoredOriginal.prepare("SELECT name FROM projects").get()).toEqual({ name: "中断前数据" });
    restoredOriginal.close();
    expect(await readdir(paths.projects)).toEqual([]);
  });

  it("accepts version 1 backups but warns that absolute paths cannot be migrated safely", async () => {
    const fixture = await createFixture();
    const backup = await createDirectoryBackup({
      destinationRoot: fixture.backupRoot,
      backupName: "legacy-v1",
      database: fixture.database.connection,
      sourcePaths: { projects: fixture.projectsPath },
      includeProjects: true,
      encryptionScopeFingerprint: fixture.scope,
    });
    const manifestPath = join(backup.backupPath, BACKUP_MANIFEST_FILE);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      format: string;
      formatVersion: number;
      source: { projectsRoot?: string | null };
    };
    // Legacy v1 identifier is intentionally retained to prove old backups remain importable.
    manifest.format = "legacy-offline-directory-backup";
    manifest.formatVersion = 1;
    delete manifest.source.projectsRoot;
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    expect((await validateDirectoryBackup(backup.backupPath)).valid).toBe(true);

    const targetUserData = join(root, "v1 target");
    const paths = {
      userData: targetUserData,
      database: join(targetUserData, "ai-tool.db"),
      projects: join(targetUserData, "projects"),
      logs: join(targetUserData, "logs"),
    };
    const prepared = await prepareDirectoryRestore(backup.backupPath, {
      paths,
      currentEncryptionScopeFingerprint: fixture.scope,
    });
    expect(prepared.rewrittenPathCount).toBe(0);
    expect(prepared.warnings.join("\n")).toContain("旧版备份没有记录源项目根目录");
  });

  it("rejects mismatched legacy/new manifest format and version pairs", async () => {
    const fixture = await createFixture();
    const backup = await createDirectoryBackup({
      destinationRoot: fixture.backupRoot,
      backupName: "format-version-pair",
      database: fixture.database.connection,
      encryptionScopeFingerprint: fixture.scope,
    });
    const manifestPath = join(backup.backupPath, BACKUP_MANIFEST_FILE);
    const original = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    // Legacy v1 identifier paired with v2 must remain invalid after the rename.
    await writeFile(manifestPath, JSON.stringify({ ...original, format: "legacy-offline-directory-backup", formatVersion: 2 }), "utf8");
    expect((await validateDirectoryBackup(backup.backupPath)).valid).toBe(false);
    await writeFile(manifestPath, JSON.stringify({ ...original, format: "ai-tool-directory-backup", formatVersion: 1 }), "utf8");
    expect((await validateDirectoryBackup(backup.backupPath)).valid).toBe(false);
  });

  it("restores an external project root without cross-volume rename operations", async () => {
    const fixture = await createFixture();
    const backup = await createDirectoryBackup({
      destinationRoot: fixture.backupRoot,
      backupName: "external-volume-restore",
      database: fixture.database.connection,
      sourcePaths: { projects: fixture.projectsPath, logs: fixture.logsPath },
      includeProjects: true,
      includeLogs: true,
      encryptionScopeFingerprint: fixture.scope,
    });
    const userData = join(root, "user-volume", "data");
    const externalProjects = join(root, "external-volume", "projects");
    const paths = {
      userData,
      database: join(userData, "ai-tool.db"),
      projects: externalProjects,
      logs: join(userData, "logs"),
    };
    await mkdir(externalProjects, { recursive: true });
    await writeFile(join(externalProjects, "current.txt"), "old", "utf8");
    const current = new AppDatabase(paths.database);
    current.close();
    await prepareDirectoryRestore(backup.backupPath, {
      paths,
      currentEncryptionScopeFingerprint: fixture.scope,
    });
    const logicalVolume = (path: unknown): "external" | "user" =>
      String(path).includes("external-volume") ? "external" : "user";
    const status = await applyPendingDirectoryRestore({
      paths: { ...paths, projects: join(userData, "projects") },
      renamePath: async (source, destination) => {
        if (logicalVolume(source) !== logicalVolume(destination)) {
          throw Object.assign(new Error("simulated cross-volume rename"), { code: "EXDEV" });
        }
        await rename(source, destination);
      },
    });
    expect(status?.status, status?.message).toBe("applied");
    expect(await readFile(join(externalProjects, "project-1", "images", "画面 01.png"), "utf8")).toBe("image-content");
    const restored = new BetterSqlite3(paths.database, { readonly: true });
    expect(restored.prepare("SELECT folder_path FROM projects").get()).toEqual({
      folder_path: join(externalProjects, "project-1"),
    });
    expect(restored.prepare("SELECT value FROM settings WHERE key = 'infer_api_key'").get()).toEqual({
      value: fixture.encrypted,
    });
    restored.close();
  });

  it("rejects overlapping restore targets even when external project roots are allowed", async () => {
    const fixture = await createFixture();
    const userData = join(root, "target-boundary");
    await expect(prepareDirectoryRestore(fixture.backupRoot, {
      paths: {
        userData,
        database: join(userData, "ai-tool.db"),
        projects: userData,
        logs: join(userData, "logs"),
      },
    })).rejects.toThrow("不能相同、包含或重叠");
  });

  it("derives an opaque stable encryption-scope fingerprint", () => {
    const first = currentEncryptionScopeFingerprint({ hostname: "machine-a", username: "user-a" });
    expect(first).toBe(currentEncryptionScopeFingerprint({ hostname: "machine-a", username: "user-a" }));
    expect(first).not.toBe(currentEncryptionScopeFingerprint({ hostname: "machine-b", username: "user-a" }));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("machine-a");
    expect(first).not.toContain("user-a");
  });
});
