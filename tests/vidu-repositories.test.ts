import { describe, expect, it } from "vitest";
import { AppDatabase } from "../src/main/database";
import {
  ProjectRepository,
  StoryboardRepository,
  ViduAccountRepository,
  ViduMaterialCacheRepository,
  viduRecoveryRetryDelayMs,
} from "../src/main/repositories";
import { fingerprintViduJwt } from "../src/main/vidu-jwt";

describe("Vidu local account persistence", () => {
  it("uses a persistent 21 minute lease and the original not-found backoff ladder", () => {
    const database = new AppDatabase(":memory:");
    try {
      const accounts = new ViduAccountRepository(database.connection);
      const projects = new ProjectRepository(database.connection);
      const storyboards = new StoryboardRepository(database.connection);
      const account = accounts.create("租约账号");
      const project = projects.create({ name: "Recovery lease" });
      const storyboard = storyboards.replace(project.id, [{ index: 0, originalText: "scene", prompt: "prompt" }])[0];
      storyboards.saveVideoProviderTask(storyboard.id, "lease-task", "vidu-browser", account.id);
      const now = Date.parse("2026-07-27T00:00:00.000Z");

      expect(storyboards.claimViduRecoveryLease(storyboard.id, "lease-task", "worker-1", now)).toBe(true);
      expect(storyboards.claimViduRecoveryLease(storyboard.id, "lease-task", "worker-2", now)).toBe(false);
      expect(storyboards.listRecoverableViduTasks(now)).toEqual([]);
      expect(storyboards.listRecoverableViduTasks(now + 21 * 60_000 + 1).map(({ id }) => id)).toEqual([storyboard.id]);
      expect(viduRecoveryRetryDelayMs("not_found", 1)).toBe(5 * 60_000);
      expect(viduRecoveryRetryDelayMs("not_found", 2)).toBe(15 * 60_000);
      expect(viduRecoveryRetryDelayMs("not_found", 3)).toBe(60 * 60_000);
      expect(viduRecoveryRetryDelayMs("not_found", 8)).toBe(60 * 60_000);
    } finally {
      database.close();
    }
  });

  it("persists original storyboard events and uses independent recovery timing fields", () => {
    const database = new AppDatabase(":memory:");
    try {
      const accounts = new ViduAccountRepository(database.connection);
      const projects = new ProjectRepository(database.connection);
      const storyboards = new StoryboardRepository(database.connection);
      const account = accounts.create("巡检事件账号");
      const project = projects.create({ name: "Recovery event parity" });
      const storyboard = storyboards.replace(project.id, [{ index: 0, originalText: "scene", prompt: "prompt" }])[0];
      const submitted = storyboards.saveVideoProviderTask(storyboard.id, "event-task", "vidu-browser", account.id);
      const firstSeenAt = Date.parse(submitted.updatedAt);

      expect(storyboards.claimViduRecoveryLease(
        storyboard.id,
        "event-task",
        "worker-too-early",
        firstSeenAt + 44_999,
        21 * 60_000,
        false,
        45_000,
      )).toBe(false);
      expect(storyboards.viduRecoveryState(storyboard.id)).toMatchObject({
        taskId: "event-task",
        firstSeenAtMs: firstSeenAt,
        lastCheckedAtMs: 0,
        checkCount: 0,
      });

      storyboards.update(storyboard.id, { prompt: "an unrelated prompt edit" });
      expect(storyboards.claimViduRecoveryLease(
        storyboard.id,
        "event-task",
        "worker-ready",
        firstSeenAt + 45_000,
        21 * 60_000,
        false,
        45_000,
      )).toBe(true);
      expect(storyboards.viduRecoveryState(storyboard.id)).toMatchObject({
        firstSeenAtMs: firstSeenAt,
        lastCheckedAtMs: firstSeenAt + 45_000,
        checkCount: 1,
        leaseOwner: "worker-ready",
      });
      expect(storyboards.events(storyboard.id).map(({ eventType }) => eventType)).toEqual([
        "patrol_check_start",
        "patrol_seen",
        "status_update",
      ]);
      expect(storyboards.events(storyboard.id)[0]).toMatchObject({
        projectId: project.id,
        index: 0,
        taskId: "event-task",
        detail: { checkCount: 1, leaseOwner: "worker-ready" },
      });

      const eventColumns = database.connection.prepare("PRAGMA table_info(storyboard_events)").all() as Array<{ name: string }>;
      const recoveryColumns = database.connection.prepare("PRAGMA table_info(storyboard_recovery_state)").all() as Array<{ name: string }>;
      expect(eventColumns.map(({ name }) => name)).toEqual([
        "id", "project_id", "idx", "event_type", "message", "detail", "task_id", "browser_index", "created_at",
      ]);
      expect(recoveryColumns.map(({ name }) => name)).toEqual([
        "project_id", "idx", "task_id", "first_seen_at_ms", "last_checked_at_ms", "check_count",
        "last_result", "consecutive_count", "next_check_at_ms", "lease_owner", "lease_until_ms", "updated_at_ms",
      ]);
    } finally {
      database.close();
    }
  });

  it("preserves the patrol result behavior of releasing its lease", () => {
    const database = new AppDatabase(":memory:");
    try {
      const accounts = new ViduAccountRepository(database.connection);
      const projects = new ProjectRepository(database.connection);
      const storyboards = new StoryboardRepository(database.connection);
      const account = accounts.create("Patrol lease account");
      const project = projects.create({ name: "Patrol lease state" });
      const storyboard = storyboards.replace(project.id, [{ index: 0, originalText: "scene", prompt: "prompt" }])[0];
      storyboards.saveVideoProviderTask(storyboard.id, "patrol-task", "vidu-browser", account.id);

      expect(storyboards.claimViduRecoveryLease(storyboard.id, "patrol-task", "worker-active")).toBe(true);
      storyboards.setVideoRecoveryState(storyboard.id, "processing", "still running");
      expect(storyboards.viduRecoveryState(storyboard.id)).toMatchObject({ leaseOwner: "", leaseUntilMs: 0 });
    } finally {
      database.close();
    }
  });

  it("round-robins the 200-item recovery batch across projects", () => {
    const database = new AppDatabase(":memory:");
    try {
      const accounts = new ViduAccountRepository(database.connection);
      const projects = new ProjectRepository(database.connection);
      const storyboards = new StoryboardRepository(database.connection);
      const account = accounts.create("Fair recovery account");
      const large = projects.create({ name: "Large recovery project" });
      const small = projects.create({ name: "Small recovery project" });
      const largeRows = storyboards.replace(large.id, Array.from({ length: 201 }, (_, index) => ({
        index,
        originalText: `large-${index}`,
        prompt: `large-${index}`,
      })));
      const smallRow = storyboards.replace(small.id, [{ index: 0, originalText: "small", prompt: "small" }])[0];
      for (const row of largeRows) storyboards.saveVideoProviderTask(row.id, `large-task-${row.index}`, "vidu-browser", account.id);
      storyboards.saveVideoProviderTask(smallRow.id, "small-task", "vidu-browser", account.id);

      const batch = storyboards.listRecoverableViduTasks(Date.now(), true);
      expect(batch).toHaveLength(200);
      expect(batch.some(({ projectId }) => projectId === large.id)).toBe(true);
      expect(batch.some(({ projectId }) => projectId === small.id)).toBe(true);
      expect(batch.slice(0, 2).map(({ projectId }) => projectId)).toEqual([large.id, small.id]);
    } finally {
      database.close();
    }
  });

  it("creates isolated account sessions and persists material fingerprints", () => {
    const database = new AppDatabase(":memory:");
    try {
      const accounts = new ViduAccountRepository(database.connection);
      const cache = new ViduMaterialCacheRepository(database.connection);
      const projects = new ProjectRepository(database.connection);
      const first = accounts.create("主账号");
      const rawJwt = "header0123456789.payload0123456789.signature0123456789";
      const jwtFingerprint = fingerprintViduJwt(rawJwt);
      const second = accounts.create("备用账号", { jwtFingerprint });
      const project = projects.create({ name: "Vidu project" });

      expect(first.id).not.toBe(second.id);
      expect(first.sessionKey).not.toBe(second.sessionKey);
      expect(second.jwtFingerprint).toBe(jwtFingerprint);
      expect(accounts.findByJwtFingerprint(jwtFingerprint)?.id).toBe(second.id);
      expect(JSON.stringify(database.connection.prepare("SELECT * FROM vidu_accounts WHERE id = ?").get(second.id))).not.toContain(rawJwt);
      expect(accounts.update(second.id, { enabled: false })).toMatchObject({ enabled: false });
      expect(cache.upsert({
        accountId: first.id,
        projectId: project.id,
        name: "小李",
        assetFingerprint: "100:200",
        materialId: "material-1",
        version: "7",
        contentUrl: "https://files.example/xiaoli.png",
      })).toMatchObject({ accountId: first.id, projectId: project.id, name: "小李", version: "7" });
    } finally {
      database.close();
    }
  });

  it("persists account type, quota, usage, reset, disable reason, and pool order", () => {
    const database = new AppDatabase(":memory:");
    try {
      const accounts = new ViduAccountRepository(database.connection);
      const member = accounts.create("会员账号", { accountType: "member", defaultQuota: 2 });
      const points = accounts.create("积分账号", { accountType: "points", defaultQuota: 3 });

      expect(accounts.recordUsage(member.id, false)).toMatchObject({ usageCount: 1, accountType: "member" });
      expect(accounts.recordUsage(member.id, true)).toMatchObject({ usageCount: 1 });
      expect(accounts.recordUsage(points.id, true)).toMatchObject({ usageCount: 1, accountType: "points" });
      expect(accounts.move(points.id, "up").map((account) => account.id)).toEqual([points.id, member.id]);
      expect(accounts.markQuotaExhausted(points.id, true, "积分不足")).toMatchObject({
        enabled: false,
        disabledReason: "credits_exhausted",
        disabledMessage: "积分不足",
      });
      expect(accounts.markSubjectLimited(member.id, "主体库操作频率超限")).toMatchObject({
        enabled: false,
        disabledReason: "subject_limit",
        disabledMessage: "主体库操作频率超限",
        disabledAt: expect.any(String),
      });
      const expired = accounts.create("登录失效账号");
      accounts.markLoginExpired(expired.id, "登录已失效");

      expect(accounts.reactivateRecoverableAccounts()).toBe(2);
      expect(accounts.get(member.id)).toMatchObject({ enabled: true, disabledReason: null, disabledMessage: null, disabledAt: null });
      expect(accounts.get(points.id)).toMatchObject({ enabled: true, disabledReason: null, disabledMessage: null, disabledAt: null });
      expect(accounts.get(expired.id)).toMatchObject({ enabled: false, disabledReason: "login_expired" });
      expect(accounts.resetDailyUsage().find((account) => account.id === member.id)).toMatchObject({ usageCount: 0 });
      expect(accounts.get(points.id)).toMatchObject({ usageCount: 1 });
    } finally {
      database.close();
    }
  });

  it("blocks account deletion while a submitted Vidu task still owns it", () => {
    const database = new AppDatabase(":memory:");
    try {
      const accounts = new ViduAccountRepository(database.connection);
      const projects = new ProjectRepository(database.connection);
      const storyboards = new StoryboardRepository(database.connection);
      const account = accounts.create("恢复账号");
      const project = projects.create({ name: "Recovery project" });
      const storyboard = storyboards.replace(project.id, [{ index: 0, originalText: "scene", prompt: "prompt" }])[0];

      expect(storyboards.saveVideoProviderTask(storyboard.id, "vidu-task-1", "vidu-browser", account.id)).toMatchObject({
        videoTaskId: "vidu-task-1",
        videoProvider: "vidu-browser",
        videoAccountId: account.id,
        videoSubmissionState: "submitted",
      });
      storyboards.clearVideoProviderTask(storyboard.id);
      accounts.delete(account.id);
      expect(accounts.list()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("allows deleting an exhausted account that only owns uncertain abnormal rows", () => {
    const database = new AppDatabase(":memory:");
    try {
      const accounts = new ViduAccountRepository(database.connection);
      const projects = new ProjectRepository(database.connection);
      const storyboards = new StoryboardRepository(database.connection);
      const account = accounts.create("用完账号", { accountType: "points", defaultQuota: 46 });
      const project = projects.create({ name: "异常项目" });
      const storyboard = storyboards.replace(project.id, [{ index: 0, originalText: "scene", prompt: "prompt" }])[0];
      database.connection.prepare("UPDATE vidu_accounts SET usage_count = 46 WHERE id = ?").run(account.id);
      storyboards.markVideoSubmissionUncertain(storyboard.id, "vidu-browser", account.id);

      accounts.delete(account.id);

      expect(accounts.list()).toEqual([]);
      expect(storyboards.get(storyboard.id)).toMatchObject({
        videoAccountId: null,
        videoSubmissionState: "uncertain",
      });
    } finally {
      database.close();
    }
  });

  it("persists all Vidu recovery states without dropping the provider task", () => {
    const database = new AppDatabase(":memory:");
    try {
      const accounts = new ViduAccountRepository(database.connection);
      const projects = new ProjectRepository(database.connection);
      const storyboards = new StoryboardRepository(database.connection);
      const account = accounts.create("恢复状态账号");
      const project = projects.create({ name: "Recovery states" });
      const storyboard = storyboards.replace(project.id, [{ index: 0, originalText: "scene", prompt: "prompt" }])[0];
      storyboards.saveVideoProviderTask(storyboard.id, "vidu-recovery-task", "vidu-browser", account.id);
      expect(storyboards.get(storyboard.id)).toMatchObject({ videoRecoveryState: "processing" });

      for (const state of ["processing", "waiting_url", "download_failed", "failed", "not_found", "unavailable"] as const) {
        expect(storyboards.setVideoRecoveryState(storyboard.id, state, `state:${state}`)).toMatchObject({
          videoTaskId: "vidu-recovery-task",
          videoRecoveryState: state,
          videoRecoveryMessage: `state:${state}`,
        });
        expect(storyboards.listRecoverableViduTasks(Date.now(), true).map(({ id }) => id)).toEqual(state === "failed" ? [] : [storyboard.id]);
      }
      expect(storyboards.listRecoverableViduTasks(Date.now(), true).map(({ id }) => id)).toEqual([storyboard.id]);
    } finally {
      database.close();
    }
  });

  it("force-stops a Vidu task atomically and makes the storyboard resubmittable", () => {
    const database = new AppDatabase(":memory:");
    try {
      const accounts = new ViduAccountRepository(database.connection);
      const projects = new ProjectRepository(database.connection);
      const storyboards = new StoryboardRepository(database.connection);
      const account = accounts.create("强停账号");
      const project = projects.create({ name: "Force stop" });
      const storyboard = storyboards.replace(project.id, [{ index: 0, originalText: "scene", prompt: "prompt" }])[0];
      storyboards.saveVideoProviderTask(storyboard.id, "vidu-force-stop", "vidu-browser", account.id);

      expect(storyboards.forceStopVideo(storyboard.id)).toMatchObject({
        status: "error",
        videoTaskId: null,
        videoSubmissionState: "idle",
        videoRecoveryState: "failed",
        videoRecoveryMessage: "已手动停止，可重新生成",
      });
      expect(storyboards.listRecoverableViduTasks()).toEqual([]);
      expect(storyboards.viduRecoveryState(storyboard.id)).toBeNull();
      expect(storyboards.events(storyboard.id)[0]).toMatchObject({
        eventType: "manual_stop",
        taskId: "vidu-force-stop",
        message: "已手动停止，可重新生成",
      });
    } finally {
      database.close();
    }
  });

  it("never auto-recovers an uncertain submission without a provider task ID", () => {
    const database = new AppDatabase(":memory:");
    try {
      const accounts = new ViduAccountRepository(database.connection);
      const projects = new ProjectRepository(database.connection);
      const storyboards = new StoryboardRepository(database.connection);
      const account = accounts.create("待确认账号");
      const project = projects.create({ name: "Uncertain submit" });
      const storyboard = storyboards.replace(project.id, [{ index: 0, originalText: "scene", prompt: "prompt" }])[0];
      storyboards.beginVideoSubmission(storyboard.id, "vidu-browser", account.id);
      storyboards.markVideoSubmissionUncertain(storyboard.id, "vidu-browser", account.id);

      expect(storyboards.get(storyboard.id)).toMatchObject({ videoSubmissionState: "uncertain", videoTaskId: null });
      expect(storyboards.listRecoverableViduTasks()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
