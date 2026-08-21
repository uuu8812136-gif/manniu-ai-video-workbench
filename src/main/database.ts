import { mkdirSync } from "node:fs";
import { dirname, resolve, toNamespacedPath } from "node:path";
import BetterSqlite3 from "better-sqlite3";

export function sqliteFilePath(filePath: string): string {
  if (filePath === ":memory:" || process.platform !== "win32") return filePath;
  return toNamespacedPath(resolve(filePath));
}

const MIGRATIONS = [
  `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      folder_path TEXT NOT NULL DEFAULT '',
      csv_path TEXT NOT NULL DEFAULT '',
      subtitle_path TEXT NOT NULL DEFAULT '',
      audio_path TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS storyboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      original_text TEXT NOT NULL DEFAULT '',
      subjects_json TEXT NOT NULL DEFAULT '[]',
      prompt TEXT NOT NULL DEFAULT '',
      duration INTEGER NOT NULL DEFAULT 4 CHECK(duration > 0),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'generating', 'done', 'error')),
      task_id TEXT,
      video_path TEXT,
      image_paths_json TEXT NOT NULL DEFAULT '[]',
      submit_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, idx)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'paused', 'done', 'error', 'cancelled')),
      progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
      input_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      detail_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_storyboards_project ON storyboards(project_id, idx);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, id);
  `,
  `
    ALTER TABLE storyboards ADD COLUMN video_task_id TEXT;
  `,
  `
    CREATE TABLE vidu_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      session_key TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE vidu_material_cache (
      account_id TEXT NOT NULL REFERENCES vidu_accounts(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      asset_fingerprint TEXT NOT NULL,
      material_id TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '',
      content_url TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(account_id, project_id, name)
    );

    ALTER TABLE storyboards ADD COLUMN video_provider TEXT NOT NULL DEFAULT 'custom-api'
      CHECK(video_provider IN ('custom-api', 'vidu-browser'));
    ALTER TABLE storyboards ADD COLUMN video_account_id TEXT REFERENCES vidu_accounts(id) ON DELETE RESTRICT;
    ALTER TABLE storyboards ADD COLUMN video_submission_state TEXT NOT NULL DEFAULT 'idle'
      CHECK(video_submission_state IN ('idle', 'submitting', 'submitted', 'uncertain'));

    UPDATE storyboards
       SET video_submission_state = 'submitted'
     WHERE video_task_id IS NOT NULL AND video_task_id <> '';

    CREATE INDEX idx_storyboards_video_account ON storyboards(video_account_id, video_submission_state);
  `,
  `
    ALTER TABLE vidu_accounts ADD COLUMN account_type TEXT NOT NULL DEFAULT 'member'
      CHECK(account_type IN ('member', 'points'));
    ALTER TABLE vidu_accounts ADD COLUMN default_quota INTEGER NOT NULL DEFAULT 200
      CHECK(default_quota BETWEEN 1 AND 500);
    ALTER TABLE vidu_accounts ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0
      CHECK(usage_count >= 0);
    ALTER TABLE vidu_accounts ADD COLUMN usage_date TEXT NOT NULL DEFAULT '';
    ALTER TABLE vidu_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE vidu_accounts ADD COLUMN disabled_reason TEXT
      CHECK(disabled_reason IS NULL OR disabled_reason IN ('credits_exhausted', 'subject_limit', 'login_expired', 'manual'));
    ALTER TABLE vidu_accounts ADD COLUMN disabled_message TEXT;
    ALTER TABLE vidu_accounts ADD COLUMN disabled_at TEXT;

    UPDATE vidu_accounts SET sort_order = rowid;
    CREATE INDEX idx_vidu_accounts_pool_order ON vidu_accounts(sort_order, created_at, id);
  `,
  `
    ALTER TABLE projects ADD COLUMN roster_path TEXT NOT NULL DEFAULT '';

    CREATE TABLE character_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      identity TEXT NOT NULL DEFAULT '',
      gender TEXT NOT NULL DEFAULT '',
      age TEXT NOT NULL DEFAULT '',
      appearance TEXT NOT NULL DEFAULT '',
      hair TEXT NOT NULL DEFAULT '',
      clothing TEXT NOT NULL DEFAULT '',
      personality TEXT NOT NULL DEFAULT '',
      visual_prompt TEXT NOT NULL DEFAULT '',
      asset_type TEXT NOT NULL DEFAULT 'character'
        CHECK(asset_type IN ('character', 'scene', 'special-space')),
      prompt TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, name)
    );

    CREATE INDEX idx_character_profiles_project_order
      ON character_profiles(project_id, sort_order, id);
  `,
  `
    ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX idx_jobs_claim_order ON jobs(status, priority DESC, created_at, id);
  `,
  `
    ALTER TABLE vidu_accounts ADD COLUMN jwt_fingerprint TEXT;
    CREATE UNIQUE INDEX idx_vidu_accounts_jwt_fingerprint
      ON vidu_accounts(jwt_fingerprint)
      WHERE jwt_fingerprint IS NOT NULL;
  `,
  `
    ALTER TABLE storyboards ADD COLUMN video_recovery_state TEXT NOT NULL DEFAULT 'idle'
      CHECK(video_recovery_state IN ('idle', 'processing', 'waiting_url', 'download_failed', 'failed', 'not_found', 'unavailable'));
    ALTER TABLE storyboards ADD COLUMN video_recovery_message TEXT;
    UPDATE storyboards
       SET video_recovery_state = 'processing'
     WHERE video_task_id IS NOT NULL AND video_task_id <> '';
    CREATE INDEX idx_storyboards_video_recovery
      ON storyboards(video_recovery_state, video_provider, video_task_id);
  `,
  `
    CREATE TABLE vidu_recovery_runtime (
      storyboard_id INTEGER PRIMARY KEY REFERENCES storyboards(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      last_result TEXT NOT NULL DEFAULT '',
      consecutive_count INTEGER NOT NULL DEFAULT 0,
      next_check_at_ms INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT NOT NULL DEFAULT '',
      lease_until_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX idx_vidu_recovery_runtime_schedule
      ON vidu_recovery_runtime(next_check_at_ms, lease_until_ms);
  `,
  `
    CREATE TABLE storyboard_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      detail TEXT,
      task_id TEXT,
      browser_index INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_storyboard_events_project_idx_created
      ON storyboard_events(project_id, idx, created_at);

    CREATE TABLE storyboard_recovery_state (
      project_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      task_id TEXT NOT NULL DEFAULT '',
      first_seen_at_ms INTEGER NOT NULL,
      last_checked_at_ms INTEGER NOT NULL DEFAULT 0,
      check_count INTEGER NOT NULL DEFAULT 0,
      last_result TEXT NOT NULL DEFAULT '',
      consecutive_count INTEGER NOT NULL DEFAULT 0,
      next_check_at_ms INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT NOT NULL DEFAULT '',
      lease_until_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(project_id, idx)
    );
    CREATE INDEX idx_storyboard_recovery_state_schedule
      ON storyboard_recovery_state(next_check_at_ms, lease_until_ms);

    INSERT INTO storyboard_recovery_state(
      project_id, idx, task_id, first_seen_at_ms, last_checked_at_ms, check_count,
      last_result, consecutive_count, next_check_at_ms, lease_owner, lease_until_ms, updated_at_ms
    )
    SELECT s.project_id, s.idx, r.task_id,
           CASE WHEN r.updated_at_ms > 0 THEN r.updated_at_ms ELSE CAST(strftime('%s','now') AS INTEGER) * 1000 END,
           r.updated_at_ms, r.consecutive_count, r.last_result, r.consecutive_count,
           r.next_check_at_ms, r.lease_owner, r.lease_until_ms, r.updated_at_ms
      FROM vidu_recovery_runtime r
      JOIN storyboards s ON s.id = r.storyboard_id
    ON CONFLICT(project_id, idx) DO NOTHING;
  `,
  `
    CREATE INDEX idx_jobs_storyboard_type_updated
      ON jobs(
        CASE WHEN json_valid(input_json)
          THEN CAST(json_extract(input_json, '$.storyboardId') AS INTEGER)
        END,
        type,
        updated_at DESC,
        id DESC
      )
      WHERE type IN ('image.generate', 'video.generate');
  `,
] as const;

export class AppDatabase {
  readonly connection: BetterSqlite3.Database;

  constructor(filePath: string) {
    if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
    this.connection = new BetterSqlite3(sqliteFilePath(filePath));
    this.connection.pragma("journal_mode = WAL");
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      this.connection
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((row) => (row as { version: number }).version),
    );
    const apply = this.connection.transaction((version: number, sql: string) => {
      this.connection.exec(sql);
      this.connection
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(version, new Date().toISOString());
    });
    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1;
      if (!applied.has(version)) apply(version, sql);
    });
  }

  close(): void {
    this.connection.close();
  }
}
