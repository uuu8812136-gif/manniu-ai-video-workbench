import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { LegacyImportCounts, LegacyImportReport } from "../shared/contracts";
import { sqliteFilePath, type AppDatabase } from "./database";

const IMPORT_MARKER_PREFIX = "legacy_import_v1_";
const IMPORT_STRATEGY = "once-per-source-path" as const;
const LEGACY_SETTING_KEY_MAP: Readonly<Record<string, string>> = {
  imagegen_save_dir: "imagegen_output_dir",
  infer_save_dir: "infer_output_dir",
  novel_opt_save_dir: "opening_output_dir",
  text_polish_save_dir: "text_polish_output_dir",
};

type SqliteRow = Record<string, unknown>;

type LegacySnapshot = {
  projects: SqliteRow[];
  storyboards: SqliteRow[];
  settings: SqliteRow[];
};

export type LegacyImportOptions = {
  dryRun?: boolean;
  now?: () => string;
};

function normalizedSourcePath(sourcePath: string): string {
  const withoutNamespace = sourcePath.startsWith("\\\\?\\UNC\\")
    ? `\\\\${sourcePath.slice(8)}`
    : sourcePath.startsWith("\\\\?\\")
      ? sourcePath.slice(4)
      : sourcePath;
  const absolute = resolve(withoutNamespace);
  let canonical = absolute;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    // The read-only open below provides the definitive missing-file error.
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function legacyImportMarkerKey(sourcePath: string): string {
  const digest = createHash("sha256").update(normalizedSourcePath(sourcePath)).digest("hex");
  return `${IMPORT_MARKER_PREFIX}${digest}`;
}

function hasTable(db: BetterSqlite3.Database, table: "projects" | "storyboards" | "settings"): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function readTable(db: BetterSqlite3.Database, table: "projects" | "storyboards" | "settings"): SqliteRow[] {
  if (!hasTable(db, table)) return [];
  return db.prepare(`SELECT * FROM ${table}`).all() as SqliteRow[];
}

function assertColumns(
  db: BetterSqlite3.Database,
  table: "projects" | "storyboards" | "settings",
  required: string[],
): void {
  if (!hasTable(db, table)) return;
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(`Legacy ${table} table is missing required columns: ${missing.join(", ")}`);
  }
}

function readLegacySnapshot(sourcePath: string): LegacySnapshot {
  const source = new BetterSqlite3(sqliteFilePath(sourcePath), { readonly: true, fileMustExist: true });
  try {
    source.pragma("query_only = ON");
    const recognized = hasTable(source, "projects") || hasTable(source, "storyboards") || hasTable(source, "settings");
    if (!recognized) throw new Error("Selected database is not a recognized legacy database");
    assertColumns(source, "projects", ["id", "name"]);
    assertColumns(source, "storyboards", ["project_id", "idx"]);
    assertColumns(source, "settings", ["key", "value"]);
    return {
      projects: readTable(source, "projects"),
      storyboards: readTable(source, "storyboards"),
      settings: readTable(source, "settings"),
    };
  } finally {
    source.close();
  }
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);
}

function integer(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = integer(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function timestamp(value: unknown, fallback: string): string {
  const candidate = text(value).trim();
  return candidate || fallback;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }

  const raw = text(value).trim();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return stringArray(parsed);
    if (typeof parsed === "string") return stringArray(parsed);
  } catch {
    // Legacy versions also stored subjects as comma-separated text.
  }
  return raw.split(/[,，、;；|\r\n]+/u).map((item) => item.trim()).filter(Boolean);
}

function storyboardStatus(value: unknown): "pending" | "generating" | "done" | "error" {
  return value === "generating" || value === "done" || value === "error" ? value : "pending";
}

function isSensitiveName(name: string): boolean {
  const normalized = name.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const compact = normalized.replace(/[.\-\s]+/g, "_");
  const collapsed = compact.replaceAll("_", "");
  return (
    compact === "saved_credentials_api_key" ||
    /(^|_)(password|passwd|pwd|jwt|token|secret|credentials?)(_|$)/u.test(compact) ||
    /(^|_)api_?key(_|$)/u.test(compact) ||
    compact.endsWith("_api_key") ||
    /(password|passwd|jwt|accesstoken|refreshtoken|authtoken|apikey|secretkey|credentials?)/u.test(collapsed)
  );
}

function jsonContainsSensitiveProperty(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) return value.some((entry) => jsonContainsSensitiveProperty(entry, seen));
  return Object.entries(value).some(
    ([key, entry]) => isSensitiveName(key) || jsonContainsSensitiveProperty(entry, seen),
  );
}

function looksLikeSecret(value: string): boolean {
  const trimmed = value.trim();
  if (/^bearer\s+\S+/iu.test(trimmed)) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(trimmed)) return true;
  if (/^(sk|pk|ghp|github_pat|xox[baprs])-[-_A-Za-z0-9]{12,}$/u.test(trimmed)) return true;
  try {
    return jsonContainsSensitiveProperty(JSON.parse(trimmed) as unknown);
  } catch {
    return false;
  }
}

export function isSensitiveLegacySetting(key: string, value: string): boolean {
  return isSensitiveName(key) || looksLikeSecret(value);
}

export function mapLegacySettingKey(key: string): string {
  const normalized = key.trim();
  return LEGACY_SETTING_KEY_MAP[normalized] ?? normalized;
}

function countSnapshot(snapshot: LegacySnapshot): LegacyImportCounts {
  return {
    projects: snapshot.projects.length,
    storyboards: snapshot.storyboards.length,
    settings: snapshot.settings.length,
  };
}

function zeroCounts(): LegacyImportCounts {
  return { projects: 0, storyboards: 0, settings: 0 };
}

export function importLegacyDatabase(
  sourcePath: string,
  target: AppDatabase,
  options: LegacyImportOptions = {},
): LegacyImportReport {
  const absoluteSourcePath = resolve(sourcePath);
  const targetPath = target.connection.name;
  if (targetPath !== ":memory:" && normalizedSourcePath(targetPath) === normalizedSourcePath(absoluteSourcePath)) {
    throw new Error("Legacy source database and target database must be different files");
  }

  const snapshot = readLegacySnapshot(absoluteSourcePath);
  const markerKey = legacyImportMarkerKey(absoluteSourcePath);
  const dryRun = options.dryRun ?? false;
  const now = options.now?.() ?? new Date().toISOString();
  const alreadyImported = Boolean(
    target.connection.prepare("SELECT 1 FROM settings WHERE key = ?").get(markerKey),
  );
  const oldProjectIds = new Set(
    snapshot.projects.map((row) => integer(row.id, Number.NaN)).filter(Number.isInteger),
  );
  const orphanStoryboards = snapshot.storyboards.filter(
    (row) => !oldProjectIds.has(integer(row.project_id, Number.NaN)),
  ).length;
  const sensitiveSettings = snapshot.settings.filter((row) =>
    isSensitiveLegacySetting(text(row.key), text(row.value)),
  );
  const safeSettings = snapshot.settings.filter(
    (row) => !isSensitiveLegacySetting(text(row.key), text(row.value)),
  );
  const normalizedSettings = new Map<string, SqliteRow>();
  for (const row of safeSettings) {
    const sourceKey = text(row.key).trim();
    const targetKey = mapLegacySettingKey(sourceKey);
    const existing = normalizedSettings.get(targetKey);
    if (!existing || sourceKey === targetKey) normalizedSettings.set(targetKey, { ...row, key: targetKey });
  }
  const existingSettingKeys = new Set(
    (target.connection.prepare("SELECT key FROM settings").all() as Array<{ key: string }>).map((row) => row.key),
  );
  const settingsToImport = [...normalizedSettings.values()].filter((row) => !existingSettingKeys.has(text(row.key)));
  const warnings: string[] = [];
  if (!hasOwnRows(snapshot.projects) && snapshot.storyboards.length > 0) {
    warnings.push("Legacy database has storyboards but no projects; orphan storyboards were skipped");
  }

  const report: LegacyImportReport = {
    sourcePath: absoluteSourcePath,
    dryRun,
    strategy: IMPORT_STRATEGY,
    markerKey,
    alreadyImported,
    scanned: countSnapshot(snapshot),
    wouldImport: alreadyImported
      ? zeroCounts()
      : {
          projects: snapshot.projects.length,
          storyboards: snapshot.storyboards.length - orphanStoryboards,
          settings: settingsToImport.length,
        },
    imported: zeroCounts(),
    skipped: {
      orphanStoryboards,
      sensitiveSettings: sensitiveSettings.length,
      existingSettings: safeSettings.length - settingsToImport.length,
    },
    sensitiveSettingKeys: sensitiveSettings.map((row) => text(row.key)),
    projectIdMap: {},
    warnings,
  };

  if (dryRun || alreadyImported) return report;

  const applyImport = target.connection.transaction(() => {
    const insertProject = target.connection.prepare(
      `INSERT INTO projects(
         name, folder_path, csv_path, subtitle_path, audio_path, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertStoryboard = target.connection.prepare(
       `INSERT INTO storyboards(
          project_id, idx, original_text, subjects_json, prompt, duration, status,
          task_id, video_task_id, video_path, image_paths_json, submit_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertSetting = target.connection.prepare(
      "INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES (?, ?, ?)",
    );

    for (const row of snapshot.projects) {
      const oldId = integer(row.id, Number.NaN);
      if (!Number.isInteger(oldId)) throw new Error("Legacy project has an invalid id");
      const createdAt = timestamp(row.created_at, now);
      const result = insertProject.run(
        text(row.name).trim() || `Legacy project ${oldId}`,
        text(row.folder_path),
        text(row.csv_path),
        text(row.subtitle_path),
        text(row.audio_path),
        createdAt,
        timestamp(row.updated_at, createdAt),
      );
      report.projectIdMap[String(oldId)] = Number(result.lastInsertRowid);
      report.imported.projects += 1;
    }

    for (const row of snapshot.storyboards) {
      const mappedProjectId = report.projectIdMap[String(integer(row.project_id, Number.NaN))];
      if (mappedProjectId === undefined) continue;
      insertStoryboard.run(
        mappedProjectId,
        integer(row.idx, 0),
        text(row.original_text),
        JSON.stringify(stringArray(row.subjects_json ?? row.subjects)),
        text(row.prompt),
        positiveInteger(row.duration, 4),
        storyboardStatus(row.status),
        row.task_id === null || row.task_id === undefined ? null : text(row.task_id),
        row.video_task_id === null || row.video_task_id === undefined ? null : text(row.video_task_id),
        row.video_path === null || row.video_path === undefined ? null : text(row.video_path),
        JSON.stringify(stringArray(row.image_paths_json ?? row.image_paths)),
        Math.max(0, integer(row.submit_count, 0)),
        timestamp(row.updated_at, now),
      );
      report.imported.storyboards += 1;
    }

    for (const row of settingsToImport) {
      const result = insertSetting.run(text(row.key), text(row.value), timestamp(row.updated_at, now));
      report.imported.settings += result.changes;
    }

    target.connection
      .prepare("INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)")
      .run(
        markerKey,
        JSON.stringify({
          importedAt: now,
          projects: report.imported.projects,
          storyboards: report.imported.storyboards,
          settings: report.imported.settings,
        }),
        now,
      );
  });

  try {
    applyImport();
  } catch (error) {
    report.projectIdMap = {};
    report.imported = zeroCounts();
    throw error;
  }
  return report;
}

function hasOwnRows(rows: SqliteRow[]): boolean {
  return rows.length > 0;
}
