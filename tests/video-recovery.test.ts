import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../src/main/database";
import { ProjectRepository, StoryboardRepository, ViduAccountRepository } from "../src/main/repositories";
import { ViduRecoveryWorker, enqueuePersistedViduRecoveries } from "../src/main/video-recovery";

describe("Vidu recovery worker", () => {
  let database: AppDatabase;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    database = new AppDatabase(":memory:");
  });

  afterEach(() => {
    database.close();
    vi.useRealTimers();
  });

  it("retries recoverable tasks after cooldown, holds a single lease, and stops cleanly", async () => {
    const accounts = new ViduAccountRepository(database.connection);
    const projects = new ProjectRepository(database.connection);
    const storyboards = new StoryboardRepository(database.connection);
    const account = accounts.create("恢复 worker 账号");
    const project = projects.create({ name: "Recovery worker" });
    const storyboard = storyboards.replace(project.id, [{ index: 0, originalText: "scene", prompt: "prompt" }])[0];
    storyboards.saveVideoProviderTask(storyboard.id, "vidu-worker-task", "vidu-browser", account.id);

    let blocking = false;
    const enqueueUniqueStoryboard = vi.fn(() => ({ id: "recovery-job" }));
    const queue = {
      store: {
        findBlockingStoryboardJob: vi.fn(() => blocking ? { id: "recovery-job" } : null),
      },
      enqueueUniqueStoryboard,
    };
    const worker = new ViduRecoveryWorker(queue as never, storyboards, {
      scanIntervalMs: 1_000,
      retryCooldownMs: 2_000,
      minimumAgeMs: 0,
    });

    expect(worker.start()).toBe(1);
    expect(enqueueUniqueStoryboard).toHaveBeenCalledTimes(1);
    expect(enqueueUniqueStoryboard).toHaveBeenLastCalledWith("video.generate", {
      storyboardId: storyboard.id,
      provider: "vidu-browser",
    });

    blocking = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(enqueueUniqueStoryboard).toHaveBeenCalledTimes(1);

    blocking = false;
    storyboards.setVideoRecoveryState(storyboard.id, "unavailable", "temporary failure");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(enqueueUniqueStoryboard).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(enqueueUniqueStoryboard).toHaveBeenCalledTimes(2);

    storyboards.clearVideoProviderTask(storyboard.id);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(enqueueUniqueStoryboard).toHaveBeenCalledTimes(2);

    worker.stop();
    storyboards.saveVideoProviderTask(storyboard.id, "vidu-worker-task-2", "vidu-browser", account.id);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(enqueueUniqueStoryboard).toHaveBeenCalledTimes(2);
  });

  it("waits 45 seconds before claiming a newly persisted task", () => {
    const accounts = new ViduAccountRepository(database.connection);
    const projects = new ProjectRepository(database.connection);
    const storyboards = new StoryboardRepository(database.connection);
    const account = accounts.create("最小年龄账号");
    const project = projects.create({ name: "Minimum age" });
    const storyboard = storyboards.replace(project.id, [{ index: 0, originalText: "scene", prompt: "prompt" }])[0];
    storyboards.saveVideoProviderTask(storyboard.id, "minimum-age-task", "vidu-browser", account.id);
    const enqueueUniqueStoryboard = vi.fn(() => ({ id: "minimum-age-job" }));
    const queue = {
      store: { findBlockingStoryboardJob: vi.fn(() => null) },
      enqueueUniqueStoryboard,
    };
    const createdAt = Date.parse(storyboards.get(storyboard.id).updatedAt);

    expect(enqueuePersistedViduRecoveries(queue as never, storyboards, { now: createdAt + 44_999 })).toBe(0);
    expect(enqueuePersistedViduRecoveries(queue as never, storyboards, { now: createdAt + 45_000 })).toBe(1);
    expect(enqueueUniqueStoryboard).toHaveBeenCalledOnce();
  });
});
