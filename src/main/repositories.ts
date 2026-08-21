import { randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import type {
  CharacterAssetType,
  CharacterProfile,
  CharacterProfileInput,
  CreateProjectInput,
  Project,
  Storyboard,
  StoryboardDraft,
  StoryboardEvent,
  StoryboardEventInput,
  StoryboardStatus,
  UpdateProjectInput,
  UpdateCharacterProfileInput,
  ViduAccount,
  ViduAccountDisabledReason,
  ViduAccountType,
  VideoProvider,
  VideoSubmissionState,
  VideoRecoveryState,
} from "../shared/contracts";

type ProjectRow = {
  id: number;
  name: string;
  folder_path: string;
  csv_path: string;
  roster_path: string;
  subtitle_path: string;
  audio_path: string;
  created_at: string;
  updated_at: string;
};

type CharacterProfileRow = {
  id: number;
  project_id: number;
  name: string;
  aliases_json: string;
  identity: string;
  gender: string;
  age: string;
  appearance: string;
  hair: string;
  clothing: string;
  personality: string;
  visual_prompt: string;
  asset_type: CharacterAssetType;
  prompt: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type StoryboardRow = {
  id: number;
  project_id: number;
  idx: number;
  original_text: string;
  subjects_json: string;
  prompt: string;
  duration: number;
  status: StoryboardStatus;
  task_id: string | null;
  video_task_id: string | null;
  video_provider: VideoProvider;
  video_account_id: string | null;
  video_submission_state: VideoSubmissionState;
  video_recovery_state: VideoRecoveryState;
  video_recovery_message: string | null;
  video_path: string | null;
  image_paths_json: string;
  submit_count: number;
  updated_at: string;
};

type ViduAccountRow = {
  id: string;
  name: string;
  session_key: string;
  jwt_fingerprint: string | null;
  enabled: 0 | 1;
  account_type: ViduAccountType;
  default_quota: number;
  usage_count: number;
  usage_date: string;
  sort_order: number;
  disabled_reason: ViduAccountDisabledReason | null;
  disabled_message: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
};

type BlockingVideoRow = {
  id: number;
  video_task_id: string | null;
  video_submission_state: VideoSubmissionState;
};

type ViduRecoveryRuntimeRow = {
  task_id: string;
  first_seen_at_ms: number;
  last_checked_at_ms: number;
  check_count: number;
  last_result: string;
  consecutive_count: number;
  next_check_at_ms: number;
  lease_owner: string;
  lease_until_ms: number;
};

type StoryboardEventRow = {
  id: number;
  project_id: number;
  idx: number;
  event_type: string;
  message: string;
  detail: string | null;
  task_id: string | null;
  browser_index: number | null;
  created_at: string;
};

export type ViduRecoveryEventSource = "patrol" | "manual";

export function viduRecoveryRetryDelayMs(result: VideoRecoveryState, consecutiveCount: number): number {
  if (result === "not_found") {
    const delays = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
    return delays[Math.min(Math.max(consecutiveCount, 1), delays.length) - 1];
  }
  if (result === "processing" || result === "waiting_url") return 30_000;
  if (result === "download_failed" || result === "unavailable") return 60_000;
  return 0;
}

const BLOCKING_VIDEO_PREDICATE =
  "(video_task_id IS NOT NULL OR video_submission_state IN ('submitting', 'submitted', 'uncertain'))";
const RESET_OR_PROJECT_DELETE_BLOCKING_VIDEO_PREDICATE =
  "(video_task_id IS NOT NULL OR video_submission_state IN ('submitting', 'submitted'))";

function assertNoBlockingVideoRows(rows: BlockingVideoRow[], action: string): void {
  const blocking = rows[0];
  if (!blocking) return;
  const detail = blocking.video_task_id
    ? `task ${blocking.video_task_id}`
    : `submission state ${blocking.video_submission_state}`;
  throw new Error(`Cannot ${action} while storyboard ${blocking.id} has persisted video ${detail}`);
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    folderPath: row.folder_path,
    csvPath: row.csv_path,
    rosterPath: row.roster_path,
    subtitlePath: row.subtitle_path,
    audioPath: row.audio_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCharacterProfile(row: CharacterProfileRow): CharacterProfile {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    aliases: stringArray(row.aliases_json),
    identity: row.identity,
    gender: row.gender,
    age: row.age,
    appearance: row.appearance,
    hair: row.hair,
    clothing: row.clothing,
    personality: row.personality,
    visualPrompt: row.visual_prompt,
    assetType: row.asset_type,
    prompt: row.prompt,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizedCharacterProfile(input: CharacterProfileInput): Required<CharacterProfileInput> {
  const name = input.name.trim();
  const visualPrompt = input.visualPrompt.trim();
  if (!name) throw new Error("角色或资产名称不能为空");
  if (!visualPrompt) throw new Error(`“${name}”缺少可用的资产提示词`);
  return {
    name,
    aliases: Array.from(new Set((input.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))),
    identity: input.identity?.trim() ?? "",
    gender: input.gender?.trim() ?? "",
    age: input.age?.trim() ?? "",
    appearance: input.appearance?.trim() ?? "",
    hair: input.hair?.trim() ?? "",
    clothing: input.clothing?.trim() ?? "",
    personality: input.personality?.trim() ?? "",
    visualPrompt,
    assetType: input.assetType ?? "character",
    prompt: input.prompt?.trim() || visualPrompt,
  };
}

function stringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function storedDetail(value: string | null): unknown | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function mapStoryboardEvent(row: StoryboardEventRow): StoryboardEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    index: row.idx,
    eventType: row.event_type,
    message: row.message,
    detail: storedDetail(row.detail),
    taskId: row.task_id,
    browserIndex: row.browser_index,
    createdAt: row.created_at,
  };
}

function mapStoryboard(row: StoryboardRow): Storyboard {
  return {
    id: row.id,
    projectId: row.project_id,
    index: row.idx,
    originalText: row.original_text,
    subjects: stringArray(row.subjects_json),
    prompt: row.prompt,
    duration: row.duration,
    status: row.status,
    taskId: row.task_id,
    videoTaskId: row.video_task_id,
    videoProvider: row.video_provider,
    videoAccountId: row.video_account_id,
    videoSubmissionState: row.video_submission_state,
    videoRecoveryState: row.video_recovery_state,
    videoRecoveryMessage: row.video_recovery_message,
    videoPath: row.video_path,
    imagePaths: stringArray(row.image_paths_json),
    submitCount: row.submit_count,
    updatedAt: row.updated_at,
  };
}

function mapViduAccount(row: ViduAccountRow): ViduAccount {
  const usageCount = row.account_type === "member" && row.usage_date !== localDateKey() ? 0 : row.usage_count;
  return {
    id: row.id,
    name: row.name,
    sessionKey: row.session_key,
    jwtFingerprint: row.jwt_fingerprint,
    enabled: row.enabled === 1,
    accountType: row.account_type,
    defaultQuota: row.default_quota,
    usageCount,
    usageDate: row.usage_date,
    sortOrder: row.sort_order,
    disabledReason: row.disabled_reason,
    disabledMessage: row.disabled_message,
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class ProjectRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC, id DESC").all() as ProjectRow[]).map(
      mapProject,
    );
  }

  get(id: number): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    if (!row) throw new Error(`项目不存在: ${id}`);
    return mapProject(row);
  }

  create(input: CreateProjectInput): Project {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO projects(
           name, folder_path, csv_path, roster_path, subtitle_path, audio_path, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name.trim(),
        input.folderPath?.trim() ?? "",
        input.csvPath?.trim() ?? "",
        input.rosterPath?.trim() ?? "",
        input.subtitlePath?.trim() ?? "",
        input.audioPath?.trim() ?? "",
        now,
        now,
      );
    return this.get(Number(result.lastInsertRowid));
  }

  update(id: number, input: UpdateProjectInput): Project {
    const current = this.get(id);
    const next = {
      name: input.name?.trim() ?? current.name,
      folderPath: input.folderPath?.trim() ?? current.folderPath,
      csvPath: input.csvPath?.trim() ?? current.csvPath,
      rosterPath: input.rosterPath?.trim() ?? current.rosterPath,
      subtitlePath: input.subtitlePath?.trim() ?? current.subtitlePath,
      audioPath: input.audioPath?.trim() ?? current.audioPath,
    };
    this.db
      .prepare(
        `UPDATE projects
         SET name = ?, folder_path = ?, csv_path = ?, roster_path = ?, subtitle_path = ?, audio_path = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.folderPath,
        next.csvPath,
        next.rosterPath,
        next.subtitlePath,
        next.audioPath,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  delete(id: number): void {
    const blocking = this.db
      .prepare(
        `SELECT id, video_task_id, video_submission_state FROM storyboards
         WHERE project_id = ? AND ${RESET_OR_PROJECT_DELETE_BLOCKING_VIDEO_PREDICATE}
         ORDER BY idx LIMIT 1`,
      )
      .all(id) as BlockingVideoRow[];
    assertNoBlockingVideoRows(blocking, "delete project");
    const remove = this.db.transaction(() => {
      this.db.prepare("DELETE FROM storyboard_recovery_state WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM storyboard_events WHERE project_id = ?").run(id);
      return this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    });
    const result = remove();
    if (result.changes === 0) throw new Error(`项目不存在: ${id}`);
  }
}

export class CharacterProfileRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(projectId: number): CharacterProfile[] {
    return (this.db
      .prepare("SELECT * FROM character_profiles WHERE project_id = ? ORDER BY sort_order, id")
      .all(projectId) as CharacterProfileRow[]).map(mapCharacterProfile);
  }

  get(id: number): CharacterProfile {
    const row = this.db.prepare("SELECT * FROM character_profiles WHERE id = ?").get(id) as CharacterProfileRow | undefined;
    if (!row) throw new Error(`角色档案不存在: ${id}`);
    return mapCharacterProfile(row);
  }

  replace(projectId: number, inputs: readonly CharacterProfileInput[]): CharacterProfile[] {
    const profiles = inputs.map(normalizedCharacterProfile);
    const replace = this.db.transaction(() => {
      this.db.prepare("DELETE FROM character_profiles WHERE project_id = ?").run(projectId);
      const insert = this.db.prepare(
        `INSERT INTO character_profiles(
           project_id, name, aliases_json, identity, gender, age, appearance, hair, clothing,
           personality, visual_prompt, asset_type, prompt, sort_order, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = new Date().toISOString();
      profiles.forEach((profile, index) => insert.run(
        projectId,
        profile.name,
        JSON.stringify(profile.aliases),
        profile.identity,
        profile.gender,
        profile.age,
        profile.appearance,
        profile.hair,
        profile.clothing,
        profile.personality,
        profile.visualPrompt,
        profile.assetType,
        profile.prompt,
        index,
        now,
        now,
      ));
      const project = this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId);
      if (project.changes !== 1) throw new Error(`项目不存在: ${projectId}`);
    });
    replace();
    return this.list(projectId);
  }

  update(id: number, input: UpdateCharacterProfileInput): CharacterProfile {
    const current = this.get(id);
    const next = normalizedCharacterProfile({
      name: input.name ?? current.name,
      aliases: input.aliases ?? current.aliases,
      identity: input.identity ?? current.identity,
      gender: input.gender ?? current.gender,
      age: input.age ?? current.age,
      appearance: input.appearance ?? current.appearance,
      hair: input.hair ?? current.hair,
      clothing: input.clothing ?? current.clothing,
      personality: input.personality ?? current.personality,
      visualPrompt: input.visualPrompt ?? current.visualPrompt,
      assetType: input.assetType ?? current.assetType,
      prompt: input.prompt ?? current.prompt,
    });
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE character_profiles
       SET name = ?, aliases_json = ?, identity = ?, gender = ?, age = ?, appearance = ?, hair = ?,
           clothing = ?, personality = ?, visual_prompt = ?, asset_type = ?, prompt = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      next.name,
      JSON.stringify(next.aliases),
      next.identity,
      next.gender,
      next.age,
      next.appearance,
      next.hair,
      next.clothing,
      next.personality,
      next.visualPrompt,
      next.assetType,
      next.prompt,
      now,
      id,
    );
    if (result.changes !== 1) throw new Error(`角色档案不存在: ${id}`);
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, current.projectId);
    return this.get(id);
  }

  delete(id: number): void {
    const current = this.get(id);
    const result = this.db.prepare("DELETE FROM character_profiles WHERE id = ?").run(id);
    if (result.changes !== 1) throw new Error(`角色档案不存在: ${id}`);
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), current.projectId);
  }

  resolve(projectId: number, names: readonly string[]): CharacterProfile[] {
    const profiles = this.list(projectId);
    const byName = new Map<string, CharacterProfile>();
    profiles.forEach((profile) => {
      [profile.name, ...profile.aliases].forEach((name) => {
        const key = name.trim().toLocaleLowerCase();
        if (key && !byName.has(key)) byName.set(key, profile);
      });
    });
    const resolved = new Map<number, CharacterProfile>();
    names.forEach((name) => {
      const profile = byName.get(name.trim().toLocaleLowerCase());
      if (profile) resolved.set(profile.id, profile);
    });
    return [...resolved.values()];
  }
}

export class StoryboardRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  private appendEventFor(storyboard: Storyboard, input: StoryboardEventInput): StoryboardEvent {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(
      `INSERT INTO storyboard_events(
         project_id, idx, event_type, message, detail, task_id, browser_index, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      storyboard.projectId,
      storyboard.index,
      input.eventType.trim(),
      input.message?.trim() ?? "",
      input.detail === undefined || input.detail === null ? null : JSON.stringify(input.detail),
      input.taskId?.trim() || null,
      input.browserIndex ?? null,
      createdAt,
    );
    return mapStoryboardEvent(this.db.prepare("SELECT * FROM storyboard_events WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as StoryboardEventRow);
  }

  private clearViduRecoveryRuntime(id: number): void {
    const storyboard = this.get(id);
    this.db.prepare("DELETE FROM storyboard_recovery_state WHERE project_id = ? AND idx = ?")
      .run(storyboard.projectId, storyboard.index);
  }

  private recordViduRecoveryResult(
    id: number,
    taskId: string,
    state: VideoRecoveryState,
    now = Date.now(),
    eventSource: ViduRecoveryEventSource = "patrol",
  ): void {
    const storyboard = this.get(id);
    const current = this.db.prepare(
      "SELECT * FROM storyboard_recovery_state WHERE project_id = ? AND idx = ?",
    ).get(storyboard.projectId, storyboard.index) as ViduRecoveryRuntimeRow | undefined;
    const consecutiveCount = current?.task_id === taskId && current.last_result === state
      ? current.consecutive_count + 1
      : 1;
    const nextCheckAt = now + viduRecoveryRetryDelayMs(state, consecutiveCount);
    this.db.prepare(
      `INSERT INTO storyboard_recovery_state(
         project_id, idx, task_id, first_seen_at_ms, last_checked_at_ms, check_count,
         last_result, consecutive_count, next_check_at_ms, lease_owner, lease_until_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, '', 0, ?)
       ON CONFLICT(project_id, idx) DO UPDATE SET
         task_id=excluded.task_id, last_result=excluded.last_result,
         consecutive_count=excluded.consecutive_count, next_check_at_ms=excluded.next_check_at_ms,
         last_checked_at_ms=excluded.last_checked_at_ms,
         lease_owner='', lease_until_ms=0, updated_at_ms=excluded.updated_at_ms`,
    ).run(storyboard.projectId, storyboard.index, taskId, current?.first_seen_at_ms ?? now, now, state, consecutiveCount, nextCheckAt, now);
    if (eventSource === "patrol") this.appendEventFor(storyboard, {
      eventType: "patrol_check_result",
      message: `自动巡检结果: ${state}`,
      detail: { result: state, consecutiveCount, nextCheckAtMs: nextCheckAt },
      taskId,
    });
  }

  claimViduRecoveryLease(
    id: number,
    taskId: string,
    owner: string,
    now = Date.now(),
    leaseMs = 21 * 60_000,
    ignoreSchedule = false,
    minimumAgeMs = 0,
    cooldownMs?: number,
    eventSource: ViduRecoveryEventSource = "patrol",
  ): boolean {
    const storyboard = this.get(id);
    const claim = this.db.transaction(() => {
      let newlySeen = false;
      let current = this.db.prepare(
        "SELECT * FROM storyboard_recovery_state WHERE project_id = ? AND idx = ?",
      ).get(storyboard.projectId, storyboard.index) as ViduRecoveryRuntimeRow | undefined;
      if (!current || current.task_id !== taskId) {
        const storyboardUpdatedAt = Date.parse(storyboard.updatedAt);
        const firstSeenAt = Number.isFinite(storyboardUpdatedAt) && storyboardUpdatedAt <= now ? storyboardUpdatedAt : now;
        this.db.prepare(
          `INSERT INTO storyboard_recovery_state(
             project_id, idx, task_id, first_seen_at_ms, last_checked_at_ms, check_count,
             last_result, consecutive_count, next_check_at_ms, lease_owner, lease_until_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, 0, 0, '', 0, 0, '', 0, ?)
           ON CONFLICT(project_id, idx) DO UPDATE SET
             task_id=excluded.task_id, first_seen_at_ms=excluded.first_seen_at_ms,
             last_checked_at_ms=0, check_count=0, last_result='', consecutive_count=0,
             next_check_at_ms=0, lease_owner='', lease_until_ms=0, updated_at_ms=excluded.updated_at_ms`,
        ).run(storyboard.projectId, storyboard.index, taskId, firstSeenAt, now);
        current = this.db.prepare(
          "SELECT * FROM storyboard_recovery_state WHERE project_id = ? AND idx = ?",
        ).get(storyboard.projectId, storyboard.index) as ViduRecoveryRuntimeRow;
        newlySeen = true;
      }
      if (newlySeen && eventSource === "patrol") {
        this.appendEventFor(storyboard, {
          eventType: "patrol_seen",
          message: "自动巡检首次观察到生成中任务",
          taskId,
        });
      }
      if (now - current.first_seen_at_ms < minimumAgeMs) return false;
      if ((!ignoreSchedule && current.next_check_at_ms > now)
        || (cooldownMs !== undefined && current.last_checked_at_ms > 0 && current.last_checked_at_ms + cooldownMs > now)
        || (current.lease_owner && current.lease_until_ms > now)) return false;
      const result = this.db.prepare(
        `UPDATE storyboard_recovery_state
         SET last_checked_at_ms = ?, check_count = check_count + 1,
             lease_owner = ?, lease_until_ms = ?, updated_at_ms = ?
         WHERE project_id = ? AND idx = ? AND task_id = ?
           AND (? = 1 OR next_check_at_ms <= ?) AND (lease_owner = '' OR lease_until_ms <= ?)`,
      ).run(now, owner, now + leaseMs, now, storyboard.projectId, storyboard.index, taskId, ignoreSchedule ? 1 : 0, now, now);
      if (result.changes === 1) {
        this.appendEventFor(storyboard, {
          eventType: eventSource === "manual" ? "manual_check_start" : "patrol_check_start",
          message: "自动巡检开始检查 Vidu 真实状态",
          detail: { checkCount: current.check_count + 1, leaseOwner: owner, source: eventSource },
          ...(eventSource === "manual" ? { message: "手动检查开始" } : {}),
          taskId,
        });
      }
      return result.changes === 1;
    });
    return claim();
  }

  releaseViduRecoveryLease(id: number, taskId: string, owner: string): void {
    const storyboard = this.get(id);
    this.db.prepare(
      `UPDATE storyboard_recovery_state
       SET lease_owner = '', lease_until_ms = 0, updated_at_ms = ?
       WHERE project_id = ? AND idx = ? AND task_id = ? AND lease_owner = ?`,
    ).run(Date.now(), storyboard.projectId, storyboard.index, taskId, owner);
  }

  list(projectId: number): Storyboard[] {
    return (
      this.db.prepare("SELECT * FROM storyboards WHERE project_id = ? ORDER BY idx").all(projectId) as StoryboardRow[]
    ).map(mapStoryboard);
  }

  get(id: number): Storyboard {
    const row = this.db.prepare("SELECT * FROM storyboards WHERE id = ?").get(id) as StoryboardRow | undefined;
    if (!row) throw new Error(`分镜不存在: ${id}`);
    return mapStoryboard(row);
  }

  events(id: number, limit = 100): StoryboardEvent[] {
    const storyboard = this.get(id);
    const safeLimit = Math.min(1_000, Math.max(1, Math.floor(limit)));
    return (this.db.prepare(
      `SELECT * FROM storyboard_events
       WHERE project_id = ? AND idx = ?
       ORDER BY id DESC LIMIT ?`,
    ).all(storyboard.projectId, storyboard.index, safeLimit) as StoryboardEventRow[]).map(mapStoryboardEvent);
  }

  appendEvent(id: number, input: StoryboardEventInput): StoryboardEvent {
    return this.appendEventFor(this.get(id), input);
  }

  viduRecoveryState(id: number): {
    taskId: string;
    firstSeenAtMs: number;
    lastCheckedAtMs: number;
    checkCount: number;
    lastResult: string;
    consecutiveCount: number;
    nextCheckAtMs: number;
    leaseOwner: string;
    leaseUntilMs: number;
  } | null {
    const storyboard = this.get(id);
    const row = this.db.prepare(
      "SELECT * FROM storyboard_recovery_state WHERE project_id = ? AND idx = ?",
    ).get(storyboard.projectId, storyboard.index) as ViduRecoveryRuntimeRow | undefined;
    return row ? {
      taskId: row.task_id,
      firstSeenAtMs: row.first_seen_at_ms,
      lastCheckedAtMs: row.last_checked_at_ms,
      checkCount: row.check_count,
      lastResult: row.last_result,
      consecutiveCount: row.consecutive_count,
      nextCheckAtMs: row.next_check_at_ms,
      leaseOwner: row.lease_owner,
      leaseUntilMs: row.lease_until_ms,
    } : null;
  }

  assertProjectHasNoBlockingVideoTasks(projectId: number, action: string): void {
    const rows = this.db
      .prepare(
        `SELECT id, video_task_id, video_submission_state FROM storyboards
         WHERE project_id = ? AND ${BLOCKING_VIDEO_PREDICATE}
         ORDER BY idx LIMIT 1`,
      )
      .all(projectId) as BlockingVideoRow[];
    assertNoBlockingVideoRows(rows, action);
  }

  assertNoBlockingVideoTasks(
    ids: Iterable<number>,
    action: string,
    options: { allowUncertain?: boolean } = {},
  ): void {
    const values = [...new Set(ids)];
    if (values.length === 0) return;
    const placeholders = values.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, video_task_id, video_submission_state FROM storyboards
         WHERE id IN (${placeholders}) AND ${options.allowUncertain ? RESET_OR_PROJECT_DELETE_BLOCKING_VIDEO_PREDICATE : BLOCKING_VIDEO_PREDICATE}
         ORDER BY id LIMIT 1`,
      )
      .all(...values) as BlockingVideoRow[];
    assertNoBlockingVideoRows(rows, action);
  }

  replace(projectId: number, drafts: StoryboardDraft[]): Storyboard[] {
    this.assertProjectHasNoBlockingVideoTasks(projectId, "replace storyboards");
    const indexes = new Set<number>();
    drafts.forEach((draft) => {
      if (indexes.has(draft.index)) throw new Error(`Duplicate storyboard index: ${draft.index}`);
      indexes.add(draft.index);
    });
    this.db.exec(
      `CREATE TEMP TABLE IF NOT EXISTS _ai_tool_import_indices(
         project_id INTEGER NOT NULL,
         idx INTEGER NOT NULL
       )`,
    );
    const replace = this.db.transaction(() => {
      this.db.prepare("DELETE FROM _ai_tool_import_indices").run();
      const rememberIndex = this.db.prepare(
        "INSERT INTO _ai_tool_import_indices(project_id, idx) VALUES (?, ?)",
      );
      const upsert = this.db.prepare(
        `INSERT INTO storyboards(
           project_id, idx, original_text, subjects_json, prompt, duration, status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(project_id, idx) DO UPDATE SET
           original_text=excluded.original_text,
           subjects_json=excluded.subjects_json,
           prompt=excluded.prompt,
           duration=excluded.duration,
           status='pending',
           task_id=NULL,
           video_task_id=NULL,
           video_provider='custom-api',
           video_account_id=NULL,
           video_submission_state='idle',
           video_recovery_state='idle',
           video_recovery_message=NULL,
           video_path=NULL,
           image_paths_json='[]',
           submit_count=0,
           updated_at=excluded.updated_at`,
      );
      const now = new Date().toISOString();
      drafts.forEach((draft) => {
        rememberIndex.run(projectId, draft.index);
        upsert.run(
          projectId,
          draft.index,
          draft.originalText,
          JSON.stringify(draft.subjects ?? []),
          draft.prompt ?? "",
          draft.duration ?? 4,
          now,
        );
      });
      this.db.prepare(
        `DELETE FROM storyboards
         WHERE project_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM _ai_tool_import_indices imported
             WHERE imported.project_id = storyboards.project_id
               AND imported.idx = storyboards.idx
           )`,
      ).run(projectId);
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId);
    });
    replace();
    return this.list(projectId);
  }

  create(projectId: number, draft: StoryboardDraft): Storyboard {
    const now = new Date().toISOString();
    const indexRow = this.db
      .prepare("SELECT COALESCE(MAX(idx), -1) + 1 AS next_index FROM storyboards WHERE project_id = ?")
      .get(projectId) as { next_index: number };
    const result = this.db
      .prepare(
        `INSERT INTO storyboards(
           project_id, idx, original_text, subjects_json, prompt, duration, status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        projectId,
        indexRow.next_index,
        draft.originalText,
        JSON.stringify(draft.subjects ?? []),
        draft.prompt ?? "",
        draft.duration ?? 4,
        now,
      );
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId);
    return this.get(Number(result.lastInsertRowid));
  }

  delete(id: number): void {
    const current = this.get(id);
    this.assertNoBlockingVideoTasks([id], "delete storyboard");
    const remove = this.db.transaction(() => {
      const remaining = this.db
        .prepare("SELECT id, idx FROM storyboards WHERE project_id = ? AND id <> ? ORDER BY idx")
        .all(current.projectId, id) as Array<{ id: number; idx: number }>;
      this.db.prepare("DELETE FROM storyboard_recovery_state WHERE project_id = ? AND idx = ?")
        .run(current.projectId, current.index);
      this.db.prepare("DELETE FROM storyboard_events WHERE project_id = ? AND idx = ?")
        .run(current.projectId, current.index);
      this.db.prepare("DELETE FROM storyboards WHERE id = ?").run(id);
      this.db.prepare("UPDATE storyboards SET idx = idx + 1000000 WHERE project_id = ?").run(current.projectId);
      this.db.prepare("UPDATE storyboard_recovery_state SET idx = idx + 1000000 WHERE project_id = ?").run(current.projectId);
      this.db.prepare("UPDATE storyboard_events SET idx = idx + 1000000 WHERE project_id = ?").run(current.projectId);
      const reindex = this.db.prepare("UPDATE storyboards SET idx = ?, updated_at = ? WHERE id = ?");
      const reindexRecovery = this.db.prepare(
        "UPDATE storyboard_recovery_state SET idx = ? WHERE project_id = ? AND idx = ?",
      );
      const reindexEvents = this.db.prepare(
        "UPDATE storyboard_events SET idx = ? WHERE project_id = ? AND idx = ?",
      );
      const now = new Date().toISOString();
      remaining.forEach((row, index) => {
        reindex.run(index, now, row.id);
        reindexRecovery.run(index, current.projectId, row.idx + 1_000_000);
        reindexEvents.run(index, current.projectId, row.idx + 1_000_000);
      });
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, current.projectId);
    });
    remove();
  }

  update(
    id: number,
    input: Partial<StoryboardDraft> & {
      status?: StoryboardStatus;
      videoPath?: string | null;
      imagePaths?: string[];
    },
  ): Storyboard {
    const current = this.get(id);
    this.db
      .prepare(
        `UPDATE storyboards
         SET idx = ?, original_text = ?, subjects_json = ?, prompt = ?, duration = ?, status = ?,
             video_path = ?, image_paths_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.index ?? current.index,
        input.originalText ?? current.originalText,
        JSON.stringify(input.subjects ?? current.subjects),
        input.prompt ?? current.prompt,
        input.duration ?? current.duration,
        input.status ?? current.status,
        input.videoPath === undefined ? current.videoPath : input.videoPath,
        JSON.stringify(input.imagePaths ?? current.imagePaths),
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  resetProjectGeneration(projectId: number): number {
    const now = new Date().toISOString();
    const reset = this.db.transaction(() => {
      const result = this.db.prepare(
        `UPDATE storyboards
         SET status = 'pending', task_id = NULL, video_task_id = NULL,
             video_account_id = NULL, video_submission_state = 'idle',
             video_recovery_state = 'idle', video_recovery_message = NULL,
             video_path = NULL, image_paths_json = '[]', submit_count = 0,
             updated_at = ?
         WHERE project_id = ?`,
      ).run(now, projectId);
      this.db.prepare("DELETE FROM storyboard_recovery_state WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM storyboard_events WHERE project_id = ?").run(projectId);
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId);
      return result.changes;
    });
    return reset();
  }

  markImageJob(id: number, status: Extract<StoryboardStatus, "generating" | "error">, taskId: string): Storyboard {
    const result = this.db
      .prepare("UPDATE storyboards SET status = ?, task_id = ?, updated_at = ? WHERE id = ?")
      .run(status, taskId, new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error(`分镜不存在: ${id}`);
    return this.get(id);
  }

  beginVideoSubmission(id: number, provider: VideoProvider, accountId: string | null): Storyboard {
    const result = this.db
      .prepare(
        `UPDATE storyboards
         SET video_provider = ?, video_account_id = ?, video_submission_state = 'submitting',
             video_recovery_state = 'idle', video_recovery_message = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(provider, accountId, new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error(`分镜不存在: ${id}`);
    this.clearViduRecoveryRuntime(id);
    const storyboard = this.get(id);
    this.appendEventFor(storyboard, {
      eventType: "status_update",
      message: "视频提交状态更新为 submitting",
      detail: { provider, accountId, submissionState: "submitting" },
    });
    return storyboard;
  }

  saveVideoProviderTask(
    id: number,
    taskId: string,
    provider?: VideoProvider,
    accountId?: string | null,
  ): Storyboard {
    const current = this.get(id);
    const result = this.db
      .prepare(
        `UPDATE storyboards
         SET video_task_id = ?, video_provider = ?, video_account_id = ?,
             video_submission_state = 'submitted',
             video_recovery_state = CASE WHEN video_task_id = ? THEN video_recovery_state ELSE 'processing' END,
             video_recovery_message = CASE WHEN video_task_id = ? THEN video_recovery_message ELSE NULL END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        taskId,
        provider ?? current.videoProvider,
        accountId === undefined ? current.videoAccountId : accountId,
        taskId,
        taskId,
        new Date().toISOString(),
        id,
      );
    if (result.changes !== 1) throw new Error(`分镜不存在: ${id}`);
    if (current.videoTaskId !== taskId) this.clearViduRecoveryRuntime(id);
    const storyboard = this.get(id);
    this.appendEventFor(storyboard, {
      eventType: "status_update",
      message: "视频提交状态更新为 submitted",
      detail: { provider: storyboard.videoProvider, accountId: storyboard.videoAccountId, submissionState: "submitted" },
      taskId,
    });
    return storyboard;
  }

  markVideoSubmissionUncertain(id: number, provider: VideoProvider, accountId: string | null): Storyboard {
    const result = this.db
      .prepare(
        `UPDATE storyboards
         SET video_provider = ?, video_account_id = ?, video_submission_state = 'uncertain',
             video_recovery_state = 'idle', video_recovery_message = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(provider, accountId, new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error(`分镜不存在: ${id}`);
    const storyboard = this.get(id);
    this.appendEventFor(storyboard, {
      eventType: "status_update",
      message: "视频提交状态更新为 uncertain",
      detail: { provider, accountId, submissionState: "uncertain" },
    });
    return storyboard;
  }

  resolveUncertainVideoSubmission(id: number, input: { taskId?: string; clear?: boolean }): Storyboard {
    const current = this.get(id);
    if (current.videoSubmissionState !== "uncertain") throw new Error("该分镜没有待确认的 Vidu 提交");
    if (input.taskId?.trim()) {
      return this.saveVideoProviderTask(id, input.taskId.trim(), current.videoProvider, current.videoAccountId);
    }
    if (!input.clear) throw new Error("请提供 Vidu task ID，或明确清除不确定状态");
    return this.clearVideoProviderTask(id);
  }

  clearVideoProviderTask(id: number): Storyboard {
    const current = this.get(id);
    const result = this.db
      .prepare(
        `UPDATE storyboards
         SET video_task_id = NULL, video_submission_state = 'idle',
             video_recovery_state = 'idle', video_recovery_message = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error(`分镜不存在: ${id}`);
    this.clearViduRecoveryRuntime(id);
    const storyboard = this.get(id);
    this.appendEventFor(storyboard, {
      eventType: "status_update",
      message: "视频提交运行时已清除",
      detail: { submissionState: "idle", clearedTaskId: current.videoTaskId },
      taskId: current.videoTaskId,
    });
    return storyboard;
  }

  clearFailedVideoProviderTask(id: number, message: string): Storyboard {
    const current = this.get(id);
    const result = this.db.prepare(
      `UPDATE storyboards
       SET status = 'error', video_task_id = NULL, video_submission_state = 'idle',
           video_recovery_state = 'failed', video_recovery_message = ?, updated_at = ?
       WHERE id = ?`,
    ).run(message.trim() || "Vidu provider reported a terminal failure", new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error(`Storyboard not found: ${id}`);
    this.clearViduRecoveryRuntime(id);
    const storyboard = this.get(id);
    this.appendEventFor(storyboard, {
      eventType: "status_update",
      message: "视频任务状态更新为 error",
      detail: { recoveryState: "failed", reason: message },
      taskId: current.videoTaskId,
    });
    return storyboard;
  }

  setVideoRecoveryState(
    id: number,
    state: VideoRecoveryState,
    message: string | null = null,
    eventSource: ViduRecoveryEventSource = "patrol",
  ): Storyboard {
    const current = this.get(id);
    const result = this.db.prepare(
      `UPDATE storyboards
       SET video_recovery_state = ?, video_recovery_message = ?, updated_at = ?
       WHERE id = ?`,
    ).run(state, message?.trim() || null, new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error(`分镜不存在: ${id}`);
    if (current.videoTaskId) {
      this.recordViduRecoveryResult(id, current.videoTaskId, state, Date.now(), eventSource);
    }
    return this.get(id);
  }

  forceStopVideo(id: number): Storyboard {
    const current = this.get(id);
    const result = this.db.prepare(
      `UPDATE storyboards
       SET status = 'error', video_task_id = NULL, video_submission_state = 'idle',
           video_recovery_state = 'failed', video_recovery_message = '已手动停止，可重新生成', updated_at = ?
       WHERE id = ?`,
    ).run(new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error(`分镜不存在: ${id}`);
    this.clearViduRecoveryRuntime(id);
    const storyboard = this.get(id);
    this.appendEventFor(storyboard, {
      eventType: "manual_stop",
      message: "已手动停止，可重新生成",
      detail: { clearedTaskId: current.videoTaskId },
      taskId: current.videoTaskId,
    });
    return storyboard;
  }

  listRecoverableViduTasks(now = Date.now(), ignoreRuntimeSchedule = false): Storyboard[] {
    return (this.db.prepare(
      `WITH ranked AS (
         SELECT s.*,
                 COALESCE(r.next_check_at_ms, 0) AS recovery_next_check_at_ms,
                 COALESCE(r.updated_at_ms, 0) AS recovery_updated_at_ms,
                ROW_NUMBER() OVER (
                  PARTITION BY s.project_id
                  ORDER BY COALESCE(r.next_check_at_ms, 0), COALESCE(r.updated_at_ms, 0), s.idx, s.id
                ) AS recovery_project_rank
         FROM storyboards s
         LEFT JOIN storyboard_recovery_state r
           ON r.project_id = s.project_id AND r.idx = s.idx AND r.task_id = s.video_task_id
         WHERE s.video_provider = 'vidu-browser'
           AND s.video_task_id IS NOT NULL AND s.video_task_id <> ''
           AND s.video_path IS NULL
           AND s.video_submission_state = 'submitted'
           AND s.video_recovery_state <> 'failed'
           AND (r.project_id IS NULL OR ((? = 1 OR r.next_check_at_ms <= ?) AND (r.lease_owner = '' OR r.lease_until_ms <= ?)))
       )
       SELECT * FROM ranked
       ORDER BY recovery_project_rank, recovery_next_check_at_ms, recovery_updated_at_ms, project_id, idx, id
       LIMIT 200`,
    ).all(ignoreRuntimeSchedule ? 1 : 0, now, now) as StoryboardRow[]).map(mapStoryboard);
  }

  attachGeneratedImage(id: number, imagePath: string, taskId: string): Storyboard {
    return this.attachGeneratedImages(id, [imagePath], taskId);
  }

  attachGeneratedImages(id: number, imagePaths: string[], taskId: string): Storyboard {
    if (imagePaths.length === 0) throw new Error("至少需要一张生成图片");
    const current = this.get(id);
    const paths = [...current.imagePaths, ...imagePaths];
    this.db
      .prepare(
        `UPDATE storyboards
         SET image_paths_json = ?, status = 'done', task_id = ?, submit_count = submit_count + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(paths), taskId, new Date().toISOString(), id);
    return this.get(id);
  }

  attachGeneratedVideo(id: number, videoPath: string): Storyboard {
    const current = this.get(id);
    const result = this.db
      .prepare(
        `UPDATE storyboards
         SET video_path = ?, status = 'done', video_task_id = NULL, video_submission_state = 'idle',
             video_recovery_state = 'idle', video_recovery_message = NULL,
             submit_count = submit_count + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(videoPath, new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error(`分镜不存在: ${id}`);
    this.clearViduRecoveryRuntime(id);
    const storyboard = this.get(id);
    this.appendEventFor(storyboard, {
      eventType: "status_update",
      message: "状态更新为 done",
      detail: { videoPath, submissionState: "idle" },
      taskId: current.videoTaskId,
    });
    return storyboard;
  }
}

export class ViduAccountRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(): ViduAccount[] {
    return (this.db.prepare("SELECT * FROM vidu_accounts ORDER BY sort_order, created_at, id").all() as ViduAccountRow[]).map(
      mapViduAccount,
    );
  }

  get(id: string): ViduAccount {
    const row = this.db.prepare("SELECT * FROM vidu_accounts WHERE id = ?").get(id) as ViduAccountRow | undefined;
    if (!row) throw new Error(`Vidu 账号不存在: ${id}`);
    return mapViduAccount(row);
  }

  create(name: string, options: { accountType?: ViduAccountType; defaultQuota?: number; jwtFingerprint?: string } = {}): ViduAccount {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Vidu 账号名称不能为空");
    const accountType = options.accountType ?? "member";
    const defaultQuota = options.defaultQuota ?? (accountType === "points" ? 46 : 200);
    if (!Number.isInteger(defaultQuota) || defaultQuota < 1 || defaultQuota > 500) {
      throw new Error("Vidu 账号额度必须是 1 到 500 的整数");
    }
    const jwtFingerprint = options.jwtFingerprint?.trim().toLowerCase() || null;
    if (jwtFingerprint !== null && !/^[0-9a-f]{64}$/.test(jwtFingerprint)) throw new Error("Vidu JWT 指纹无效");
    const id = randomUUID();
    const now = new Date().toISOString();
    const nextOrder = (this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM vidu_accounts").get() as { value: number }).value;
    this.db
      .prepare(
        `INSERT INTO vidu_accounts(
           id, name, session_key, jwt_fingerprint, enabled, account_type, default_quota, usage_count, usage_date,
           sort_order, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?, 0, '', ?, ?, ?)`,
      )
      .run(id, trimmed, randomUUID(), jwtFingerprint, accountType, defaultQuota, nextOrder, now, now);
    return this.get(id);
  }

  findByJwtFingerprint(fingerprint: string): ViduAccount | null {
    const row = this.db.prepare("SELECT * FROM vidu_accounts WHERE jwt_fingerprint = ?").get(fingerprint) as ViduAccountRow | undefined;
    return row ? mapViduAccount(row) : null;
  }

  update(id: string, input: {
    name?: string;
    enabled?: boolean;
    accountType?: ViduAccountType;
    defaultQuota?: number;
    clearDisabled?: boolean;
  }): ViduAccount {
    const current = this.get(id);
    const name = input.name === undefined ? current.name : input.name.trim();
    if (!name) throw new Error("Vidu 账号名称不能为空");
    const accountType = input.accountType ?? current.accountType;
    const defaultQuota = input.defaultQuota ?? current.defaultQuota;
    if (!Number.isInteger(defaultQuota) || defaultQuota < 1 || defaultQuota > 500) {
      throw new Error("Vidu 账号额度必须是 1 到 500 的整数");
    }
    const clearDisabled = input.clearDisabled === true || input.enabled === true;
    this.db
      .prepare(
        `UPDATE vidu_accounts
         SET name = ?, enabled = ?, account_type = ?, default_quota = ?,
             disabled_reason = CASE WHEN ? THEN NULL ELSE disabled_reason END,
             disabled_message = CASE WHEN ? THEN NULL ELSE disabled_message END,
             disabled_at = CASE WHEN ? THEN NULL ELSE disabled_at END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        name,
        (input.enabled ?? current.enabled) ? 1 : 0,
        accountType,
        defaultQuota,
        clearDisabled ? 1 : 0,
        clearDisabled ? 1 : 0,
        clearDisabled ? 1 : 0,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  move(id: string, direction: "up" | "down"): ViduAccount[] {
    const ordered = this.list();
    const index = ordered.findIndex((account) => account.id === id);
    if (index < 0) throw new Error(`Vidu 账号不存在: ${id}`);
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= ordered.length) return ordered;
    const now = new Date().toISOString();
    const swap = this.db.transaction(() => {
      this.db.prepare("UPDATE vidu_accounts SET sort_order = ?, updated_at = ? WHERE id = ?")
        .run(ordered[target].sortOrder, now, ordered[index].id);
      this.db.prepare("UPDATE vidu_accounts SET sort_order = ?, updated_at = ? WHERE id = ?")
        .run(ordered[index].sortOrder, now, ordered[target].id);
    });
    swap();
    return this.list();
  }

  resetDailyUsage(): ViduAccount[] {
    this.db.prepare(
      `UPDATE vidu_accounts
       SET usage_count = 0, usage_date = '', updated_at = ?
       WHERE account_type = 'member'`,
    ).run(new Date().toISOString());
    return this.list();
  }

  recordUsage(id: string, useCredits: boolean): ViduAccount {
    const current = this.get(id);
    if (current.accountType === "member" && useCredits) return current;
    const today = localDateKey();
    const nextUsage = current.accountType === "points" || current.usageDate === today
      ? current.usageCount + 1
      : 1;
    this.db.prepare(
      "UPDATE vidu_accounts SET usage_count = ?, usage_date = ?, updated_at = ? WHERE id = ?",
    ).run(nextUsage, current.accountType === "member" ? today : current.usageDate, new Date().toISOString(), id);
    return this.get(id);
  }

  markQuotaExhausted(id: string, useCredits: boolean, message: string): ViduAccount {
    const current = this.get(id);
    const now = new Date().toISOString();
    if (current.accountType === "points") {
      this.db.prepare(
        `UPDATE vidu_accounts
         SET enabled = 0, disabled_reason = 'credits_exhausted', disabled_message = ?, disabled_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(message, now, now, id);
    } else if (!useCredits) {
      this.db.prepare(
        "UPDATE vidu_accounts SET usage_count = default_quota, usage_date = ?, updated_at = ? WHERE id = ?",
      ).run(localDateKey(), now, id);
    }
    return this.get(id);
  }

  markLoginExpired(id: string, message: string): ViduAccount {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE vidu_accounts
       SET enabled = 0, disabled_reason = 'login_expired', disabled_message = ?, disabled_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(message, now, now, id);
    return this.get(id);
  }

  markSubjectLimited(id: string, message: string): ViduAccount {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE vidu_accounts
       SET enabled = 0, disabled_reason = 'subject_limit', disabled_message = ?, disabled_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(message, now, now, id);
    return this.get(id);
  }

  reactivateRecoverableAccounts(): number {
    const now = new Date().toISOString();
    return this.db.prepare(
      `UPDATE vidu_accounts
       SET enabled = 1, disabled_reason = NULL, disabled_message = NULL, disabled_at = NULL, updated_at = ?
       WHERE disabled_reason IN ('subject_limit', 'credits_exhausted')`,
    ).run(now).changes;
  }

  assertCanDelete(id: string): ViduAccount {
    const account = this.get(id);
    const blocking = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM storyboards
         WHERE video_account_id = ?
            AND (video_task_id IS NOT NULL OR video_submission_state IN ('submitting', 'submitted'))`,
      )
      .get(id) as { count: number };
    if (blocking.count > 0) throw new Error("该账号仍有未完成或待确认的视频任务，不能删除");
    return account;
  }

  delete(id: string): void {
    this.assertCanDelete(id);
    const remove = this.db.transaction(() => {
      this.db.prepare("UPDATE storyboards SET video_account_id = NULL WHERE video_account_id = ?").run(id);
      this.db.prepare("DELETE FROM vidu_accounts WHERE id = ?").run(id);
    });
    remove();
  }
}

export type ViduMaterialCacheEntry = {
  accountId: string;
  projectId: number;
  name: string;
  assetFingerprint: string;
  materialId: string;
  version: string;
  contentUrl: string;
  updatedAt: string;
};

type ViduMaterialCacheRow = {
  account_id: string;
  project_id: number;
  name: string;
  asset_fingerprint: string;
  material_id: string;
  version: string;
  content_url: string;
  updated_at: string;
};

function mapViduMaterialCache(row: ViduMaterialCacheRow): ViduMaterialCacheEntry {
  return {
    accountId: row.account_id,
    projectId: row.project_id,
    name: row.name,
    assetFingerprint: row.asset_fingerprint,
    materialId: row.material_id,
    version: row.version,
    contentUrl: row.content_url,
    updatedAt: row.updated_at,
  };
}

export class ViduMaterialCacheRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  get(accountId: string, projectId: number, name: string): ViduMaterialCacheEntry | null {
    const row = this.db
      .prepare("SELECT * FROM vidu_material_cache WHERE account_id = ? AND project_id = ? AND name = ?")
      .get(accountId, projectId, name) as ViduMaterialCacheRow | undefined;
    return row ? mapViduMaterialCache(row) : null;
  }

  upsert(entry: Omit<ViduMaterialCacheEntry, "updatedAt">): ViduMaterialCacheEntry {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO vidu_material_cache(
           account_id, project_id, name, asset_fingerprint, material_id, version, content_url, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, project_id, name) DO UPDATE SET
           asset_fingerprint = excluded.asset_fingerprint,
           material_id = excluded.material_id,
           version = excluded.version,
           content_url = excluded.content_url,
           updated_at = excluded.updated_at`,
      )
      .run(
        entry.accountId,
        entry.projectId,
        entry.name,
        entry.assetFingerprint,
        entry.materialId,
        entry.version,
        entry.contentUrl,
        now,
      );
    return this.get(entry.accountId, entry.projectId, entry.name)!;
  }

  delete(accountId: string, projectId: number, name: string): void {
    this.db
      .prepare("DELETE FROM vidu_material_cache WHERE account_id = ? AND project_id = ? AND name = ?")
      .run(accountId, projectId, name);
  }
}

export class SettingsRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(): Record<string, string> {
    return Object.fromEntries(
      (this.db.prepare("SELECT key, value FROM settings ORDER BY key").all() as Array<{ key: string; value: string }>).map(
        (row) => [row.key, row.value],
      ),
    );
  }

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }
}
