import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { z } from "zod";
import { isSecretSettingKey } from "./secure-settings";

export const BACKUP_FORMAT_VERSION = 2;
export const BACKUP_MANIFEST_FILE = "manifest.json";
export const PENDING_RESTORE_FILE = "pending-restore.json";
export const LAST_RESTORE_FILE = "last-restore.json";
const RESTORE_PLAN_FILE = "restore-plan.json";
const RESTORE_STAGING_DIRECTORY = ".restore-staging";

const backupCategory = z.enum(["database", "projects", "logs"]);
const manifestEntry = z.object({
  path: z.string().min(1).max(32_767),
  category: backupCategory,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const backupManifestBody = z.object({
  backupId: z.string().uuid(),
  createdAt: z.string().datetime(),
  appVersion: z.string().min(1).max(120),
  source: z.object({
    platform: z.string().min(1).max(40),
    architecture: z.string().min(1).max(40),
    encryptionScopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    projectsRoot: z.string().max(32_767).nullable().optional(),
  }),
  sqlite: z.object({
    relativePath: z.string().min(1).max(32_767),
    quickCheck: z.literal("ok"),
    schemaVersion: z.number().int().nonnegative(),
  }),
  security: z.object({
    protectedSettingCount: z.number().int().nonnegative(),
    protectedSettingKeys: z.array(z.string().min(1).max(120)).max(1_000),
    encryption: z.literal("dpapi-user-machine-bound"),
    crossScopeRequiresReentry: z.literal(true),
  }),
  included: z.object({ projects: z.boolean(), logs: z.boolean() }),
  entries: z.array(manifestEntry).min(1).max(1_000_000),
});
const backupManifestSchema = z.union([
  backupManifestBody.extend({
    format: z.string().regex(/^[a-z0-9-]+-offline-directory-backup$/),
    formatVersion: z.literal(1),
  }),
  backupManifestBody.extend({
    format: z.literal("ai-tool-directory-backup"),
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  }),
]);

const pendingRestoreSchema = z.object({
  format: z.literal("ai-tool-pending-restore"),
  version: z.literal(1),
  restoreId: z.string().uuid(),
});

const restorePlanEntry = manifestEntry.extend({ path: z.string().min(1).max(32_767) });
const restorePlanSchema = z.object({
  format: z.literal("ai-tool-restore-plan"),
  version: z.literal(1),
  restoreId: z.string().uuid(),
  backupPath: z.string().min(1).max(32_767),
  createdAt: z.string().datetime(),
  included: z.object({ projects: z.boolean(), logs: z.boolean() }),
  security: z.object({
    requiresSecretReentry: z.boolean(),
    clearedSettingKeys: z.array(z.string().min(1).max(120)).max(1_000),
  }),
  pathMigration: z.object({
    sourceProjectsRoot: z.string().max(32_767).nullable(),
    targetProjectsRoot: z.string().min(1).max(32_767),
    rewrittenCount: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string().max(65_535)).max(10_000),
  entries: z.array(restorePlanEntry).min(1).max(1_000_000),
});

const restoreStatusSchema = z.object({
  status: z.enum(["applied", "failed"]),
  restoreId: z.string().uuid(),
  completedAt: z.string().datetime(),
  message: z.string().min(1).max(65_535),
  rollbackPath: z.string().max(32_767).nullable(),
  rollbackPaths: z.array(z.string().min(1).max(32_767)).max(10),
  requiresSecretReentry: z.boolean(),
  clearedSettingKeys: z.array(z.string().min(1).max(120)).max(1_000),
  warnings: z.array(z.string().max(65_535)).max(10_000),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;
export type BackupManifestEntry = z.infer<typeof manifestEntry>;
export type BackupCategory = z.infer<typeof backupCategory>;
export type RestorePlan = z.infer<typeof restorePlanSchema>;
export type RestoreStatus = z.infer<typeof restoreStatusSchema>;

export type BackupSourcePaths = {
  projects?: string;
  logs?: string;
};

export type CreateBackupOptions = {
  destinationRoot: string;
  database: BetterSqlite3.Database;
  sourcePaths?: BackupSourcePaths;
  includeProjects?: boolean;
  includeLogs?: boolean;
  backupName?: string;
  appVersion?: string;
  encryptionScopeFingerprint?: string;
  now?: () => Date;
};

export type CreateBackupResult = {
  backupPath: string;
  manifestPath: string;
  manifest: BackupManifest;
  warnings: string[];
  totalFiles: number;
  totalBytes: number;
};

export type BackupValidationReport = {
  backupPath: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest: {
    backupId: string | null;
    createdAt: string | null;
    appVersion: string | null;
    formatVersion: number | null;
    totalFiles: number;
    totalBytes: number;
    included: { projects: boolean; logs: boolean } | null;
  };
  database: {
    healthy: boolean;
    quickCheck: string[];
    error: string | null;
  };
  security: {
    protectedSettingCount: number;
    protectedSettingKeys: string[];
    encryptedValuesExposed: false;
  };
};

export type RestoreDestinations = {
  database?: string;
  projects?: string;
  logs?: string;
};

export type RestorePreflightOptions = {
  currentEncryptionScopeFingerprint?: string;
  destinations?: RestoreDestinations;
};

export type RestoreDestinationCheck = {
  category: BackupCategory;
  path: string;
  exists: boolean;
  writable: boolean;
  error: string | null;
};

export type RestorePreflightReport = {
  backupPath: string;
  ready: boolean;
  validation: BackupValidationReport;
  destinations: RestoreDestinationCheck[];
  security: {
    sourceScopeMatches: boolean;
    requiresSecretReentry: boolean;
    protectedSettingCount: number;
    protectedSettingKeys: string[];
    message: string | null;
  };
};

export type RestoreRuntimePaths = {
  userData: string;
  database: string;
  projects: string;
  logs: string;
};

export type PrepareRestoreOptions = {
  paths: RestoreRuntimePaths;
  currentEncryptionScopeFingerprint?: string;
  now?: () => Date;
};

export type PreparedRestoreResult = {
  restoreId: string;
  backupPath: string;
  restartRequired: true;
  requiresSecretReentry: boolean;
  clearedSettingKeys: string[];
  rewrittenPathCount: number;
  warnings: string[];
};

export type ApplyPendingRestoreOptions = {
  paths: RestoreRuntimePaths;
  now?: () => Date;
  renamePath?: typeof rename;
};

type CopyTreeResult = {
  entries: BackupManifestEntry[];
  warnings: string[];
};

function sanitizeBackupName(value: string): string {
  let name = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
  if (!name) throw new Error("备份名称不能为空");
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name.slice(0, 120);
}

function defaultBackupName(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `ai-tool-backup-${stamp}`;
}

function asManifestPath(value: string): string {
  return value.split(sep).join("/");
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relation = relative(resolve(parentPath), resolve(childPath));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function assertDestinationOutsideSource(destinationRoot: string, sourcePath: string, label: string): void {
  if (isPathInside(sourcePath, destinationRoot)) {
    throw new Error(`备份目标目录不能位于 ${label} 源目录内部: ${destinationRoot}`);
  }
}

function fromManifestPath(value: string): string[] {
  if (isAbsolute(value) || value.includes("\\")) throw new Error(`备份条目路径不是安全相对路径: ${value}`);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`备份条目路径不是安全相对路径: ${value}`);
  }
  return parts;
}

function resolveManifestEntry(backupPath: string, entryPath: string): string {
  const target = resolve(backupPath, ...fromManifestPath(entryPath));
  const relation = relative(backupPath, target);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`备份条目越出备份目录: ${entryPath}`);
  return target;
}

async function assertNoSymlinkInPath(rootPath: string, targetPath: string): Promise<void> {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  const relation = relative(root, target);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`路径越出受控目录: ${target}`);
  let current = root;
  for (const part of relation.split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`受控目录中不允许符号链接: ${current}`);
  }
}

export function currentEncryptionScopeFingerprint(
  scope: { hostname: string; username: string } = { hostname: hostname(), username: userInfo().username },
): string {
  return createHash("sha256")
    .update(`ai-tool-dpapi-scope-v1\0${scope.hostname}\0${scope.username}`, "utf8")
    .digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

function quickCheckRows(database: BetterSqlite3.Database): string[] {
  const rows = database.pragma("quick_check") as unknown;
  if (!Array.isArray(rows)) return [String(rows)];
  return rows.map((row) => {
    if (typeof row === "string") return row;
    if (row && typeof row === "object") return String(Object.values(row as Record<string, unknown>)[0] ?? "");
    return String(row);
  });
}

function schemaVersion(database: BetterSqlite3.Database): number {
  try {
    const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
      | { version: number | null }
      | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

function protectedSettingKeys(database: BetterSqlite3.Database): string[] {
  try {
    return (database.prepare("SELECT key FROM settings WHERE value <> '' ORDER BY key").all() as Array<{ key: string }>)
      .map((row) => row.key)
      .filter(isSecretSettingKey);
  } catch {
    return [];
  }
}

type ProjectPathRow = {
  id: number;
  name: string;
  folder_path: string;
  csv_path: string;
  roster_path: string;
  subtitle_path: string;
  audio_path: string;
};

type StoryboardPathRow = {
  id: number;
  project_id: number;
  video_path: string | null;
  image_paths_json: string;
};

function externalProjectReferenceWarnings(
  database: BetterSqlite3.Database,
  projectsRoot: string,
): string[] {
  const root = resolve(projectsRoot);
  const warnings = new Set<string>();
  const check = (label: string, value: string | null | undefined): void => {
    const path = value?.trim();
    if (!path) return;
    if (!isAbsolute(path) || !isPathInside(root, path)) {
      warnings.add(`外部引用未包含在备份中（${label}）: ${path}`);
    }
  };

  const projects = database
    .prepare("SELECT id, name, folder_path, csv_path, roster_path, subtitle_path, audio_path FROM projects ORDER BY id")
    .all() as ProjectPathRow[];
  for (const project of projects) {
    const prefix = `项目 ${project.id}“${project.name}”`;
    check(`${prefix}目录`, project.folder_path);
    check(`${prefix} CSV`, project.csv_path);
    check(`${prefix}角色表`, project.roster_path);
    check(`${prefix}字幕`, project.subtitle_path);
    check(`${prefix}音频`, project.audio_path);
  }

  const storyboards = database
    .prepare("SELECT id, project_id, video_path, image_paths_json FROM storyboards ORDER BY id")
    .all() as StoryboardPathRow[];
  for (const storyboard of storyboards) {
    const prefix = `项目 ${storyboard.project_id} 分镜 ${storyboard.id}`;
    check(`${prefix}视频`, storyboard.video_path);
    let imagePaths: unknown;
    try {
      imagePaths = JSON.parse(storyboard.image_paths_json) as unknown;
    } catch {
      warnings.add(`${prefix}的图片路径数据无法解析，未确认是否已包含在备份中`);
      continue;
    }
    if (!Array.isArray(imagePaths)) {
      warnings.add(`${prefix}的图片路径数据格式无效，未确认是否已包含在备份中`);
      continue;
    }
    imagePaths.forEach((path, index) => {
      if (typeof path === "string") check(`${prefix}图片 ${index + 1}`, path);
    });
  }
  return [...warnings];
}

async function copyDirectoryTree(
  sourceRoot: string,
  targetRoot: string,
  manifestRoot: string,
  category: Extract<BackupCategory, "projects" | "logs">,
): Promise<CopyTreeResult> {
  const entries: BackupManifestEntry[] = [];
  const warnings: string[] = [];
  let sourceInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    sourceInfo = await lstat(sourceRoot);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return { entries, warnings: [`${category} 目录不存在，已跳过: ${sourceRoot}`] };
    throw error;
  }
  if (!sourceInfo.isDirectory()) throw new Error(`${category} 路径不是目录: ${sourceRoot}`);
  await mkdir(targetRoot, { recursive: true });

  const walk = async (sourceDirectory: string, targetDirectory: string): Promise<void> => {
    const names = (await readdir(sourceDirectory)).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const sourcePath = join(sourceDirectory, name);
      const targetPath = join(targetDirectory, name);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) {
        warnings.push(`已跳过符号链接: ${sourcePath}`);
        continue;
      }
      if (info.isDirectory()) {
        await mkdir(targetPath, { recursive: true });
        await walk(sourcePath, targetPath);
        continue;
      }
      if (!info.isFile()) {
        warnings.push(`已跳过非普通文件: ${sourcePath}`);
        continue;
      }
      await copyFile(sourcePath, targetPath);
      const copied = await stat(targetPath);
      entries.push({
        path: asManifestPath(relative(manifestRoot, targetPath)),
        category,
        size: copied.size,
        sha256: await sha256File(targetPath),
      });
    }
  };
  await walk(sourceRoot, targetRoot);
  return { entries, warnings };
}

async function writeManifest(filePath: string, manifest: BackupManifest): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  try {
    const { open } = await import("node:fs/promises");
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createDirectoryBackup(options: CreateBackupOptions): Promise<CreateBackupResult> {
  const now = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new TypeError("now 返回了无效日期");
  const destinationRoot = resolve(options.destinationRoot);
  const backupName = sanitizeBackupName(options.backupName ?? defaultBackupName(now));
  const backupPath = join(destinationRoot, backupName);
  const stagingPath = join(destinationRoot, `.${backupName}.${randomUUID()}.staging`);
  const databaseRelativePath = "database/ai-tool.db";
  const databasePath = join(stagingPath, ...databaseRelativePath.split("/"));
  const warnings: string[] = [];
  const entries: BackupManifestEntry[] = [];
  const includeProjects = options.includeProjects ?? Boolean(options.sourcePaths?.projects);
  const includeLogs = options.includeLogs ?? Boolean(options.sourcePaths?.logs);

  if (includeProjects && options.sourcePaths?.projects) {
    assertDestinationOutsideSource(destinationRoot, options.sourcePaths.projects, "projects");
  }
  if (includeLogs && options.sourcePaths?.logs) {
    assertDestinationOutsideSource(destinationRoot, options.sourcePaths.logs, "logs");
  }

  await mkdir(destinationRoot, { recursive: true });
  try {
    await stat(backupPath);
    throw new Error(`备份目录已存在: ${backupPath}`);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }

  await mkdir(dirname(databasePath), { recursive: true });
  try {
    await options.database.backup(databasePath);
    const snapshot = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
    let quickCheck: string[];
    let version: number;
    let secretKeys: string[];
    try {
      snapshot.pragma("query_only = ON");
      quickCheck = quickCheckRows(snapshot);
      if (quickCheck.length !== 1 || quickCheck[0].toLowerCase() !== "ok") {
        throw new Error(`SQLite 快照完整性检查失败: ${quickCheck.join("; ")}`);
      }
      version = schemaVersion(snapshot);
      secretKeys = protectedSettingKeys(snapshot);
      if (includeProjects && options.sourcePaths?.projects) {
        warnings.push(...externalProjectReferenceWarnings(snapshot, options.sourcePaths.projects));
      }
    } finally {
      snapshot.close();
    }

    const databaseInfo = await stat(databasePath);
    entries.push({
      path: databaseRelativePath,
      category: "database",
      size: databaseInfo.size,
      sha256: await sha256File(databasePath),
    });

    if (includeProjects) {
      if (!options.sourcePaths?.projects) throw new Error("includeProjects 为 true 时必须提供 projects 路径");
      const result = await copyDirectoryTree(
        resolve(options.sourcePaths.projects),
        join(stagingPath, "user-data", "projects"),
        stagingPath,
        "projects",
      );
      entries.push(...result.entries);
      warnings.push(...result.warnings);
    }
    if (includeLogs) {
      if (!options.sourcePaths?.logs) throw new Error("includeLogs 为 true 时必须提供 logs 路径");
      const result = await copyDirectoryTree(
        resolve(options.sourcePaths.logs),
        join(stagingPath, "user-data", "logs"),
        stagingPath,
        "logs",
      );
      entries.push(...result.entries);
      warnings.push(...result.warnings);
    }

    entries.sort((left, right) => left.path.localeCompare(right.path));
    const scopeFingerprint = options.encryptionScopeFingerprint ?? currentEncryptionScopeFingerprint();
    if (!/^[a-f0-9]{64}$/.test(scopeFingerprint)) throw new Error("encryptionScopeFingerprint 必须是 SHA-256 十六进制值");
    const manifest: BackupManifest = {
      format: "ai-tool-directory-backup",
      formatVersion: BACKUP_FORMAT_VERSION,
      backupId: randomUUID(),
      createdAt: now.toISOString(),
      appVersion: options.appVersion?.trim() || "unknown",
      source: {
        platform: process.platform,
        architecture: process.arch,
        encryptionScopeFingerprint: scopeFingerprint,
        projectsRoot: options.sourcePaths?.projects ? resolve(options.sourcePaths.projects) : null,
      },
      sqlite: { relativePath: databaseRelativePath, quickCheck: "ok", schemaVersion: version },
      security: {
        protectedSettingCount: secretKeys.length,
        protectedSettingKeys: secretKeys,
        encryption: "dpapi-user-machine-bound",
        crossScopeRequiresReentry: true,
      },
      included: { projects: includeProjects, logs: includeLogs },
      entries,
    };
    backupManifestSchema.parse(manifest);
    await writeManifest(join(stagingPath, BACKUP_MANIFEST_FILE), manifest);
    await rename(stagingPath, backupPath);
    return {
      backupPath,
      manifestPath: join(backupPath, BACKUP_MANIFEST_FILE),
      manifest,
      warnings,
      totalFiles: entries.length,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function emptyValidation(backupPath: string): BackupValidationReport {
  return {
    backupPath,
    valid: false,
    errors: [],
    warnings: [],
    manifest: {
      backupId: null,
      createdAt: null,
      appVersion: null,
      formatVersion: null,
      totalFiles: 0,
      totalBytes: 0,
      included: null,
    },
    database: { healthy: false, quickCheck: [], error: null },
    security: { protectedSettingCount: 0, protectedSettingKeys: [], encryptedValuesExposed: false },
  };
}

export async function validateDirectoryBackup(backupDirectory: string): Promise<BackupValidationReport> {
  const backupPath = resolve(backupDirectory);
  const report = emptyValidation(backupPath);
  let manifest: BackupManifest;
  try {
    const raw: unknown = JSON.parse(await readFile(join(backupPath, BACKUP_MANIFEST_FILE), "utf8"));
    manifest = backupManifestSchema.parse(raw);
  } catch (error) {
    report.errors.push(`manifest 无效: ${error instanceof Error ? error.message : String(error)}`);
    return report;
  }
  if (manifest.formatVersion >= 2 && manifest.source.projectsRoot === undefined) {
    report.errors.push("v2 manifest 缺少 source.projectsRoot");
  }
  if (manifest.formatVersion >= 2 && manifest.included.projects && !manifest.source.projectsRoot) {
    report.errors.push("v2 manifest 包含项目文件但缺少源项目根目录");
  }
  if (manifest.source.projectsRoot && !isAbsolute(manifest.source.projectsRoot)) {
    report.errors.push("source.projectsRoot 必须是绝对路径");
  }

  report.manifest = {
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    appVersion: manifest.appVersion,
    formatVersion: manifest.formatVersion,
    totalFiles: manifest.entries.length,
    totalBytes: manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
    included: manifest.included,
  };
  report.security = {
    protectedSettingCount: manifest.security.protectedSettingCount,
    protectedSettingKeys: [...manifest.security.protectedSettingKeys],
    encryptedValuesExposed: false,
  };
  if (manifest.security.protectedSettingCount !== manifest.security.protectedSettingKeys.length) {
    report.errors.push("敏感设置计数与键名列表不一致");
  }
  if (new Set(manifest.security.protectedSettingKeys).size !== manifest.security.protectedSettingKeys.length) {
    report.errors.push("敏感设置键名列表包含重复项");
  }
  if (manifest.security.protectedSettingCount > 0) {
    report.warnings.push(
      `备份包含 ${manifest.security.protectedSettingCount} 项 DPAPI 保护设置；跨 Windows 用户或计算机恢复后必须重新填写。`,
    );
  }

  const seenPaths = new Set<string>();
  for (const entry of manifest.entries) {
    const portableKey = entry.path.toLowerCase();
    if (seenPaths.has(portableKey)) {
      report.errors.push(`manifest 包含重复路径: ${entry.path}`);
      continue;
    }
    seenPaths.add(portableKey);
    if (entry.category === "database" && entry.path !== manifest.sqlite.relativePath) {
      report.errors.push(`SQLite 分类路径与 sqlite.relativePath 不一致: ${entry.path}`);
    }
    if (entry.category === "projects" && !entry.path.startsWith("user-data/projects/")) {
      report.errors.push(`projects 条目路径不在预期目录: ${entry.path}`);
    }
    if (entry.category === "logs" && !entry.path.startsWith("user-data/logs/")) {
      report.errors.push(`logs 条目路径不在预期目录: ${entry.path}`);
    }
    let filePath: string;
    try {
      filePath = resolveManifestEntry(backupPath, entry.path);
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    try {
      const info = await lstat(filePath);
      await assertNoSymlinkInPath(backupPath, filePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        report.errors.push(`备份条目不是普通文件: ${entry.path}`);
        continue;
      }
      if (info.size !== entry.size) report.errors.push(`文件大小不匹配: ${entry.path}`);
      const digest = await sha256File(filePath);
      if (digest !== entry.sha256) report.errors.push(`SHA-256 不匹配: ${entry.path}`);
    } catch (error) {
      report.errors.push(`无法读取备份条目 ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const databaseEntries = manifest.entries.filter((entry) => entry.category === "database");
  if (databaseEntries.length !== 1) report.errors.push(`manifest 必须且只能包含一个 SQLite 条目，当前为 ${databaseEntries.length}`);
  if (!manifest.included.projects && manifest.entries.some((entry) => entry.category === "projects")) {
    report.errors.push("included.projects=false 但 manifest 包含 projects 条目");
  }
  if (!manifest.included.logs && manifest.entries.some((entry) => entry.category === "logs")) {
    report.errors.push("included.logs=false 但 manifest 包含 logs 条目");
  }

  const databaseEntry = manifest.entries.find(
    (entry) => entry.category === "database" && entry.path === manifest.sqlite.relativePath,
  );
  if (!databaseEntry) {
    report.errors.push("manifest 缺少 SQLite 快照条目");
  } else {
    try {
      const databasePath = resolveManifestEntry(backupPath, databaseEntry.path);
      const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
      try {
        database.pragma("query_only = ON");
        report.database.quickCheck = quickCheckRows(database);
        report.database.healthy =
          report.database.quickCheck.length === 1 && report.database.quickCheck[0].toLowerCase() === "ok";
        if (!report.database.healthy) report.errors.push("SQLite 快照 quick_check 未通过");
      } finally {
        database.close();
      }
    } catch (error) {
      report.database.error = error instanceof Error ? error.message : String(error);
      report.errors.push(`SQLite 快照无法只读校验: ${report.database.error}`);
    }
  }

  report.valid = report.errors.length === 0 && report.database.healthy;
  return report;
}

async function nearestExistingParent(targetPath: string): Promise<string> {
  let current = resolve(targetPath);
  while (true) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function checkRestoreDestination(
  category: BackupCategory,
  destinationPath: string,
): Promise<RestoreDestinationCheck> {
  const path = resolve(destinationPath);
  let exists = false;
  let existingInfo: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    existingInfo = await stat(path);
    exists = true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") {
      return { category, path, exists: false, writable: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (existingInfo) {
    const expectedTypeMatches = category === "database" ? existingInfo.isFile() : existingInfo.isDirectory();
    if (!expectedTypeMatches) {
      return {
        category,
        path,
        exists,
        writable: false,
        error: category === "database" ? "数据库恢复目标不能是目录" : `${category} 恢复目标不能是文件`,
      };
    }
  }
  try {
    const accessPath = exists ? path : await nearestExistingParent(path);
    await access(accessPath, constants.W_OK);
    return { category, path, exists, writable: true, error: null };
  } catch (error) {
    return { category, path, exists, writable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function preflightDirectoryRestore(
  backupDirectory: string,
  options: RestorePreflightOptions = {},
): Promise<RestorePreflightReport> {
  const validation = await validateDirectoryBackup(backupDirectory);
  const backupPath = validation.backupPath;
  let sourceScope = "";
  if (validation.valid) {
    try {
      const manifest = backupManifestSchema.parse(
        JSON.parse(await readFile(join(backupPath, BACKUP_MANIFEST_FILE), "utf8")) as unknown,
      );
      sourceScope = manifest.source.encryptionScopeFingerprint;
    } catch {
      // validateDirectoryBackup already reports malformed manifests.
    }
  }
  const currentScope = options.currentEncryptionScopeFingerprint ?? currentEncryptionScopeFingerprint();
  const sourceScopeMatches = Boolean(sourceScope) && sourceScope === currentScope;
  const requiresSecretReentry =
    validation.security.protectedSettingCount > 0 && !sourceScopeMatches;
  const destinations = await Promise.all(
    Object.entries(options.destinations ?? {}).map(([category, path]) =>
      checkRestoreDestination(category as BackupCategory, path),
    ),
  );
  return {
    backupPath,
    ready: validation.valid && destinations.every((destination) => destination.writable),
    validation,
    destinations,
    security: {
      sourceScopeMatches,
      requiresSecretReentry,
      protectedSettingCount: validation.security.protectedSettingCount,
      protectedSettingKeys: [...validation.security.protectedSettingKeys],
      message: requiresSecretReentry
        ? "备份来自不同的 Windows 用户或计算机，DPAPI 密文不可迁移；恢复后必须重新填写所列 API Key/Secret 设置。"
        : null,
    },
  };
}

function normalizedPathKey(value: string): string {
  const path = resolve(value);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function assertRestoreRuntimePaths(paths: RestoreRuntimePaths): RestoreRuntimePaths {
  const resolved = {
    userData: resolve(paths.userData),
    database: resolve(paths.database),
    projects: resolve(paths.projects),
    logs: resolve(paths.logs),
  };
  const targets = [resolved.database, resolved.projects, resolved.logs];
  for (let left = 0; left < targets.length; left += 1) {
    for (let right = left + 1; right < targets.length; right += 1) {
      if (isPathInside(targets[left], targets[right]) || isPathInside(targets[right], targets[left])) {
        throw new Error("数据库、项目和日志恢复目标不能相同、包含或重叠");
      }
    }
  }
  return resolved;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return false;
    throw error;
  }
}

async function readBackupManifest(backupPath: string): Promise<BackupManifest> {
  return backupManifestSchema.parse(
    JSON.parse(await readFile(join(backupPath, BACKUP_MANIFEST_FILE), "utf8")) as unknown,
  );
}

function stagedPathForEntry(entry: BackupManifestEntry, manifest: BackupManifest): string {
  if (entry.category === "database") {
    if (entry.path !== manifest.sqlite.relativePath) throw new Error(`SQLite 条目路径不一致: ${entry.path}`);
    return "database/restored.db";
  }
  const prefix = entry.category === "projects" ? "user-data/projects/" : "user-data/logs/";
  if (!entry.path.startsWith(prefix)) throw new Error(`备份条目不在 ${entry.category} 目录: ${entry.path}`);
  const suffix = entry.path.slice(prefix.length);
  fromManifestPath(suffix);
  return `${entry.category}/${suffix}`;
}

function assertRestorePlanEntry(entry: z.infer<typeof restorePlanEntry>): void {
  const parts = fromManifestPath(entry.path);
  const expectedRoot = entry.category === "database" ? "database" : entry.category;
  if (parts[0] !== expectedRoot) throw new Error(`恢复计划条目分类与路径不一致: ${entry.path}`);
  if (entry.category === "database" && entry.path !== "database/restored.db") {
    throw new Error(`恢复计划 SQLite 路径无效: ${entry.path}`);
  }
}

function rewriteRestoredDatabasePaths(
  database: BetterSqlite3.Database,
  sourceProjectsRoot: string | null,
  targetProjectsRoot: string,
): { rewrittenCount: number; warnings: string[] } {
  const warnings = new Set<string>();
  let rewrittenCount = 0;
  if (!sourceProjectsRoot) {
    warnings.add("旧版备份没有记录源项目根目录，数据库中的绝对素材路径未自动改写，请恢复后检查项目路径。");
    return { rewrittenCount, warnings: [...warnings] };
  }
  const sourceRoot = resolve(sourceProjectsRoot);
  const targetRoot = resolve(targetProjectsRoot);
  const migrate = (label: string, raw: string | null): string | null => {
    const value = raw?.trim() ?? "";
    if (!value) return raw;
    if (!isAbsolute(value) || !isPathInside(sourceRoot, value)) {
      warnings.add(`外部引用未改写（${label}）: ${value}`);
      return raw;
    }
    const migrated = join(targetRoot, relative(sourceRoot, resolve(value)));
    if (normalizedPathKey(migrated) !== normalizedPathKey(value)) rewrittenCount += 1;
    return migrated;
  };

  const update = database.transaction(() => {
    const projects = database
      .prepare("SELECT id, name, folder_path, csv_path, roster_path, subtitle_path, audio_path FROM projects ORDER BY id")
      .all() as ProjectPathRow[];
    const updateProject = database.prepare(
      "UPDATE projects SET folder_path = ?, csv_path = ?, roster_path = ?, subtitle_path = ?, audio_path = ? WHERE id = ?",
    );
    for (const project of projects) {
      const prefix = `项目 ${project.id}“${project.name}”`;
      updateProject.run(
        migrate(`${prefix}目录`, project.folder_path),
        migrate(`${prefix} CSV`, project.csv_path),
        migrate(`${prefix}角色表`, project.roster_path),
        migrate(`${prefix}字幕`, project.subtitle_path),
        migrate(`${prefix}音频`, project.audio_path),
        project.id,
      );
    }

    const storyboards = database
      .prepare("SELECT id, project_id, video_path, image_paths_json FROM storyboards ORDER BY id")
      .all() as StoryboardPathRow[];
    const updateStoryboard = database.prepare(
      "UPDATE storyboards SET video_path = ?, image_paths_json = ? WHERE id = ?",
    );
    for (const storyboard of storyboards) {
      const prefix = `项目 ${storyboard.project_id} 分镜 ${storyboard.id}`;
      let images: unknown;
      try {
        images = JSON.parse(storyboard.image_paths_json) as unknown;
      } catch {
        warnings.add(`${prefix}的图片路径数据无法解析，未执行路径迁移`);
        images = storyboard.image_paths_json;
      }
      const migratedImages = Array.isArray(images)
        ? images.map((path, index) => typeof path === "string" ? migrate(`${prefix}图片 ${index + 1}`, path) : path)
        : images;
      updateStoryboard.run(
        migrate(`${prefix}视频`, storyboard.video_path),
        typeof migratedImages === "string" ? migratedImages : JSON.stringify(migratedImages),
        storyboard.id,
      );
    }

    const baseFolder = database.prepare("SELECT value FROM settings WHERE key = 'project_base_folder'").get() as
      | { value: string }
      | undefined;
    if (baseFolder) {
      database.prepare("UPDATE settings SET value = ? WHERE key = 'project_base_folder'").run(
        migrate("项目根目录设置", baseFolder.value),
      );
    }
  });
  update();
  return { rewrittenCount, warnings: [...warnings] };
}

function clearProtectedSettings(database: BetterSqlite3.Database, keys: string[]): string[] {
  if (keys.length === 0) return [];
  const cleared: string[] = [];
  const clear = database.transaction(() => {
    const statement = database.prepare("UPDATE settings SET value = '' WHERE key = ? AND value <> ''");
    for (const key of keys) {
      if (statement.run(key).changes > 0) cleared.push(key);
    }
  });
  clear();
  return cleared;
}

async function writeRestoreStatus(userData: string, status: RestoreStatus): Promise<void> {
  restoreStatusSchema.parse(status);
  await writeFileAtomic(join(userData, LAST_RESTORE_FILE), `${JSON.stringify(status, null, 2)}\n`);
}

export async function readLastRestoreStatus(userData: string): Promise<RestoreStatus | null> {
  try {
    return restoreStatusSchema.parse(JSON.parse(await readFile(join(resolve(userData), LAST_RESTORE_FILE), "utf8")) as unknown);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return null;
    throw error;
  }
}

export async function prepareDirectoryRestore(
  backupDirectory: string,
  options: PrepareRestoreOptions,
): Promise<PreparedRestoreResult> {
  const paths = assertRestoreRuntimePaths(options.paths);
  const pendingPath = join(paths.userData, PENDING_RESTORE_FILE);
  await mkdir(paths.userData, { recursive: true });
  if (await pathExists(pendingPath)) throw new Error("已有等待重启执行的恢复任务");

  const preflight = await preflightDirectoryRestore(backupDirectory, {
    currentEncryptionScopeFingerprint: options.currentEncryptionScopeFingerprint,
    destinations: { database: paths.database, projects: paths.projects, logs: paths.logs },
  });
  if (!preflight.ready) {
    const errors = [
      ...preflight.validation.errors,
      ...preflight.destinations.flatMap((destination) => destination.error ? [destination.error] : []),
    ];
    throw new Error(`备份不能恢复: ${errors.join("; ") || "恢复预检未通过"}`);
  }

  const backupPath = preflight.backupPath;
  const manifest = await readBackupManifest(backupPath);
  const restoreId = randomUUID();
  const stagingRoot = join(paths.userData, RESTORE_STAGING_DIRECTORY, restoreId);
  const warnings = [...preflight.validation.warnings];
  const stagedEntries: Array<z.infer<typeof restorePlanEntry>> = [];
  try {
    await mkdir(join(stagingRoot, "database"), { recursive: true });
    if (manifest.included.projects) await mkdir(join(stagingRoot, "projects"), { recursive: true });
    if (manifest.included.logs) await mkdir(join(stagingRoot, "logs"), { recursive: true });
    for (const entry of manifest.entries) {
      const relativePath = stagedPathForEntry(entry, manifest);
      const sourcePath = resolveManifestEntry(backupPath, entry.path);
      const targetPath = resolveManifestEntry(stagingRoot, relativePath);
      await assertNoSymlinkInPath(backupPath, sourcePath);
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      const copied = await stat(targetPath);
      const digest = await sha256File(targetPath);
      if (copied.size !== entry.size || digest !== entry.sha256) {
        throw new Error(`恢复 staging 校验失败: ${entry.path}`);
      }
      stagedEntries.push({ ...entry, path: relativePath });
    }

    const stagedDatabasePath = join(stagingRoot, "database", "restored.db");
    const restoredDatabase = new BetterSqlite3(stagedDatabasePath, { fileMustExist: true });
    let rewrittenCount = 0;
    let clearedSettingKeys: string[] = [];
    try {
      const migrated = rewriteRestoredDatabasePaths(
        restoredDatabase,
        manifest.source.projectsRoot ?? null,
        paths.projects,
      );
      rewrittenCount = migrated.rewrittenCount;
      warnings.push(...migrated.warnings);
      if (preflight.security.requiresSecretReentry) {
        clearedSettingKeys = clearProtectedSettings(restoredDatabase, manifest.security.protectedSettingKeys);
        warnings.push("备份来自不同的 Windows 用户或计算机，受保护的 API Key/Secret 已清空，重启后必须重新填写。");
      }
      const check = quickCheckRows(restoredDatabase);
      if (check.length !== 1 || check[0].toLowerCase() !== "ok") {
        throw new Error(`恢复数据库完整性检查失败: ${check.join("; ")}`);
      }
    } finally {
      restoredDatabase.close();
    }

    const databaseEntry = stagedEntries.find((entry) => entry.category === "database");
    if (!databaseEntry) throw new Error("恢复 staging 缺少数据库");
    const databaseInfo = await stat(stagedDatabasePath);
    databaseEntry.size = databaseInfo.size;
    databaseEntry.sha256 = await sha256File(stagedDatabasePath);
    const now = (options.now ?? (() => new Date()))();
    const plan: RestorePlan = {
      format: "ai-tool-restore-plan",
      version: 1,
      restoreId,
      backupPath,
      createdAt: now.toISOString(),
      included: { ...manifest.included },
      security: {
        requiresSecretReentry: preflight.security.requiresSecretReentry,
        clearedSettingKeys,
      },
      pathMigration: {
        sourceProjectsRoot: manifest.source.projectsRoot ?? null,
        targetProjectsRoot: paths.projects,
        rewrittenCount,
      },
      warnings: [...new Set(warnings)],
      entries: stagedEntries.sort((left, right) => left.path.localeCompare(right.path)),
    };
    restorePlanSchema.parse(plan);
    await writeFileAtomic(join(stagingRoot, RESTORE_PLAN_FILE), `${JSON.stringify(plan, null, 2)}\n`);
    await writeFileAtomic(pendingPath, `${JSON.stringify({ format: "ai-tool-pending-restore", version: 1, restoreId }, null, 2)}\n`);
    return {
      restoreId,
      backupPath,
      restartRequired: true,
      requiresSecretReentry: plan.security.requiresSecretReentry,
      clearedSettingKeys: [...plan.security.clearedSettingKeys],
      rewrittenPathCount: rewrittenCount,
      warnings: [...plan.warnings],
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

type RestoreMove = { target: string; rollback: string };
type RestoreCategoryTarget = {
  category: BackupCategory;
  source: string;
  swap: string;
  target: string;
  rollback: string;
  failed: string;
};

function siblingRestorePath(target: string, restoreId: string, role: "new" | "rollback" | "failed"): string {
  return join(dirname(target), `.${basename(target)}.ai-tool-restore-${role}-${restoreId}`);
}

function restoreCategories(plan: RestorePlan, stagingRoot: string, paths: RestoreRuntimePaths): RestoreCategoryTarget[] {
  const create = (category: BackupCategory, source: string, target: string): RestoreCategoryTarget => ({
    category,
    source,
    swap: siblingRestorePath(target, plan.restoreId, "new"),
    target,
    rollback: siblingRestorePath(target, plan.restoreId, "rollback"),
    failed: siblingRestorePath(target, plan.restoreId, "failed"),
  });
  return [
    create("database", join(stagingRoot, "database", "restored.db"), paths.database),
    ...(plan.included.projects ? [create("projects", join(stagingRoot, "projects"), paths.projects)] : []),
    ...(plan.included.logs ? [create("logs", join(stagingRoot, "logs"), paths.logs)] : []),
  ];
}

async function materializeCategorySwap(item: RestoreCategoryTarget, plan: RestorePlan): Promise<void> {
  await rm(item.swap, { recursive: true, force: true });
  await mkdir(dirname(item.swap), { recursive: true });
  if (item.category === "database") {
    await copyFile(item.source, item.swap);
  } else {
    await mkdir(item.swap, { recursive: true });
    const prefix = `${item.category}/`;
    for (const entry of plan.entries.filter(({ category }) => category === item.category)) {
      if (!entry.path.startsWith(prefix)) throw new Error(`恢复计划路径不在 ${item.category} 分类下: ${entry.path}`);
      const suffix = entry.path.slice(prefix.length);
      const target = resolve(item.swap, ...fromManifestPath(suffix));
      const relation = relative(item.swap, target);
      if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`恢复临时路径越界: ${entry.path}`);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolveManifestEntry(item.source, suffix), target);
    }
  }
  for (const entry of plan.entries.filter(({ category }) => category === item.category)) {
    const filePath = item.category === "database"
      ? item.swap
      : resolve(item.swap, ...fromManifestPath(entry.path.slice(`${item.category}/`.length)));
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size || await sha256File(filePath) !== entry.sha256) {
      throw new Error(`目标同卷恢复临时文件校验失败: ${entry.path}`);
    }
  }
}

async function moveIfPresent(target: string, rollback: string, renamePath: typeof rename, moves: RestoreMove[]): Promise<void> {
  if (!(await pathExists(target))) return;
  await rm(rollback, { recursive: true, force: true });
  await renamePath(target, rollback);
  moves.push({ target, rollback });
}

async function rollbackAppliedRestore(
  installedTargets: RestoreCategoryTarget[],
  originalMoves: RestoreMove[],
  renamePath: typeof rename,
): Promise<void> {
  for (const item of [...installedTargets].reverse()) {
    if (!(await pathExists(item.target))) continue;
    await rm(item.failed, { recursive: true, force: true });
    await renamePath(item.target, item.failed);
  }
  for (const move of [...originalMoves].reverse()) {
    if (!(await pathExists(move.rollback))) continue;
    await mkdir(dirname(move.target), { recursive: true });
    await renamePath(move.rollback, move.target);
  }
}

async function recoverInterruptedRestore(
  categories: RestoreCategoryTarget[],
  paths: RestoreRuntimePaths,
  renamePath: typeof rename,
): Promise<void> {
  for (const item of categories) {
    if (await pathExists(item.rollback)) {
      if (await pathExists(item.target)) {
        await rm(item.failed, { recursive: true, force: true });
        await renamePath(item.target, item.failed);
      }
      await renamePath(item.rollback, item.target);
    } else if (!(await pathExists(item.swap)) && await pathExists(item.target)) {
      await rm(item.failed, { recursive: true, force: true });
      await renamePath(item.target, item.failed);
    }
    if (item.category === "database") {
      for (const suffix of ["-wal", "-shm"]) {
        const rollback = `${item.rollback}${suffix}`;
        const target = `${paths.database}${suffix}`;
        if (!(await pathExists(rollback))) continue;
        const failed = `${item.failed}${suffix}`;
        if (await pathExists(target)) {
          await rm(failed, { force: true });
          await renamePath(target, failed);
        }
        await renamePath(rollback, target);
      }
    }
    await rm(item.swap, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function existingRollbackPaths(categories: RestoreCategoryTarget[]): Promise<string[]> {
  const paths: string[] = [];
  for (const item of categories) {
    if (await pathExists(item.rollback)) paths.push(item.rollback);
    if (await pathExists(item.failed)) paths.push(item.failed);
  }
  return paths;
}

export async function applyPendingDirectoryRestore(
  options: ApplyPendingRestoreOptions,
): Promise<RestoreStatus | null> {
  let paths = assertRestoreRuntimePaths(options.paths);
  const pendingPath = join(paths.userData, PENDING_RESTORE_FILE);
  let pending: z.infer<typeof pendingRestoreSchema>;
  try {
    pending = pendingRestoreSchema.parse(JSON.parse(await readFile(pendingPath, "utf8")) as unknown);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return null;
    await rm(pendingPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const stagingRoot = join(paths.userData, RESTORE_STAGING_DIRECTORY, pending.restoreId);
  const renamePath = options.renamePath ?? rename;
  let plan: RestorePlan | null = null;
  let categories: RestoreCategoryTarget[] = [];
  const originalMoves: RestoreMove[] = [];
  const installedTargets: RestoreCategoryTarget[] = [];
  try {
    plan = restorePlanSchema.parse(
      JSON.parse(await readFile(join(stagingRoot, RESTORE_PLAN_FILE), "utf8")) as unknown,
    );
    if (plan.restoreId !== pending.restoreId) throw new Error("恢复计划 ID 与 pending 标记不一致");
    paths = assertRestoreRuntimePaths({ ...paths, projects: plan.pathMigration.targetProjectsRoot });
    categories = restoreCategories(plan, stagingRoot, paths);
    const replacementStartedPath = join(stagingRoot, "replacement-started");
    if (await pathExists(replacementStartedPath)) {
      await recoverInterruptedRestore(categories, paths, renamePath);
      await rm(pendingPath, { force: true });
      const rollbackPaths = await existingRollbackPaths(categories);
      const status: RestoreStatus = {
        status: "failed",
        restoreId: plan.restoreId,
        completedAt: (options.now ?? (() => new Date()))().toISOString(),
        message: "检测到上次恢复在替换阶段中断，原数据已自动回滚；请检查 rollback 目录后重新发起恢复。",
        rollbackPath: rollbackPaths[0] ?? null,
        rollbackPaths,
        requiresSecretReentry: plan.security.requiresSecretReentry,
        clearedSettingKeys: [...plan.security.clearedSettingKeys],
        warnings: [...plan.warnings],
      };
      await writeRestoreStatus(paths.userData, status);
      return status;
    }
    for (const entry of plan.entries) {
      assertRestorePlanEntry(entry);
      const filePath = resolveManifestEntry(stagingRoot, entry.path);
      const info = await lstat(filePath);
      await assertNoSymlinkInPath(stagingRoot, filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size || await sha256File(filePath) !== entry.sha256) {
        throw new Error(`恢复 staging 文件校验失败: ${entry.path}`);
      }
    }
    const databaseEntries = plan.entries.filter((entry) => entry.category === "database");
    if (databaseEntries.length !== 1) throw new Error("恢复计划必须包含一个数据库文件");
    const stagedDatabase = new BetterSqlite3(join(stagingRoot, "database", "restored.db"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const check = quickCheckRows(stagedDatabase);
      if (check.length !== 1 || check[0].toLowerCase() !== "ok") throw new Error("恢复 staging 数据库 quick_check 未通过");
    } finally {
      stagedDatabase.close();
    }

    for (const item of categories) await materializeCategorySwap(item, plan);
    await writeFileAtomic(replacementStartedPath, `${JSON.stringify({ restoreId: plan.restoreId })}\n`);
    for (const item of categories) {
      await moveIfPresent(item.target, item.rollback, renamePath, originalMoves);
      if (item.category === "database") {
        await moveIfPresent(`${paths.database}-wal`, `${item.rollback}-wal`, renamePath, originalMoves);
        await moveIfPresent(`${paths.database}-shm`, `${item.rollback}-shm`, renamePath, originalMoves);
      }
      await mkdir(dirname(item.target), { recursive: true });
      await renamePath(item.swap, item.target);
      installedTargets.push(item);
    }

    await rm(pendingPath, { force: true });
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    const rollbackPaths = await existingRollbackPaths(categories);
    const status: RestoreStatus = {
      status: "applied",
      restoreId: plan.restoreId,
      completedAt: (options.now ?? (() => new Date()))().toISOString(),
      message: plan.security.requiresSecretReentry
        ? "备份已恢复；跨 Windows 用户或计算机的 API Key/Secret 已清空，请重新填写。"
        : "备份已恢复。",
      rollbackPath: rollbackPaths[0] ?? null,
      rollbackPaths,
      requiresSecretReentry: plan.security.requiresSecretReentry,
      clearedSettingKeys: [...plan.security.clearedSettingKeys],
      warnings: [...plan.warnings],
    };
    await writeRestoreStatus(paths.userData, status);
    return status;
  } catch (error) {
    let rollbackError: unknown = null;
    try {
      await rollbackAppliedRestore(installedTargets, originalMoves, renamePath);
      for (const item of categories) {
        await rm(item.swap, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (reason) {
      rollbackError = reason;
    }
    await rm(pendingPath, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    const rollbackPaths = await existingRollbackPaths(categories).catch(() => []);
    const replacementChanged = installedTargets.length > 0 || originalMoves.length > 0;
    const status: RestoreStatus = {
      status: "failed",
      restoreId: pending.restoreId,
      completedAt: (options.now ?? (() => new Date()))().toISOString(),
      message: rollbackError
        ? `恢复失败且自动回滚未完成: ${message}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        : replacementChanged
          ? `恢复失败，原数据已回滚: ${message}`
          : `恢复失败，原数据未修改: ${message}`,
      rollbackPath: rollbackPaths[0] ?? null,
      rollbackPaths,
      requiresSecretReentry: plan?.security.requiresSecretReentry ?? false,
      clearedSettingKeys: [...(plan?.security.clearedSettingKeys ?? [])],
      warnings: [...(plan?.warnings ?? [])],
    };
    await writeRestoreStatus(paths.userData, status).catch(() => undefined);
    return status;
  }
}
