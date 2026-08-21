import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/main/database";
import {
  DESKTOP_JOB_CONCURRENCY,
  JobStore,
  PauseJobError,
  PersistentJobQueue,
} from "../src/main/jobs";

async function waitUntil(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("persistent job queue", () => {
  let database: AppDatabase;
  let store: JobStore;

  beforeEach(() => {
    database = new AppDatabase(":memory:");
    store = new JobStore(database.connection);
  });

  afterEach(() => database.close());

  it("persists progress, output and execution events", async () => {
    const queue = new PersistentJobQueue(store);
    queue.register<{ value: number }, { doubled: number }>("double", async (input, context) => {
      context.emit("debug", "Input accepted", input);
      context.updateProgress(40, "First stage complete");
      context.updateProgress(80, "Second stage complete");
      return { doubled: input.value * 2 };
    });
    queue.start();

    const created = queue.enqueue("double", { value: 21 }, "job-progress");
    expect(created.status).toBe("queued");
    await queue.waitForIdle(1_000);

    expect(store.require("job-progress")).toMatchObject({
      status: "done",
      progress: 100,
      attempts: 1,
      output: { doubled: 42 },
      error: null,
    });
    expect(store.events("job-progress").map((event) => event.message)).toEqual([
      "Job queued",
      "Job started",
      "Input accepted",
      "First stage complete",
      "Second stage complete",
      "Job completed",
    ]);
  });

  it("returns only the latest image and video job for requested storyboards", () => {
    const oldImage = store.enqueue("image.generate", { storyboardId: 7 }, "old-image");
    const latestImage = store.enqueue("image.generate", { storyboardId: 7 }, "latest-image");
    const video = store.enqueue("video.generate", { storyboardId: 7 }, "latest-video");
    store.enqueue("image.generate", { storyboardId: 8 }, "other-storyboard");
    store.enqueue("text.polish", { storyboardId: 7 }, "unrelated-type");
    database.connection.prepare(
      `INSERT INTO jobs(
         id, type, status, progress, input_json, output_json, error, attempts, priority, created_at, updated_at
       ) VALUES (?, 'video.generate', 'error', 0, ?, NULL, NULL, 0, 0, ?, ?)`,
    ).run("malformed-input", "{not-json", "2026-07-26T00:04:00.000Z", "2026-07-26T00:04:00.000Z");
    database.connection.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run("2026-07-26T00:01:00.000Z", oldImage.id);
    database.connection.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run("2026-07-26T00:02:00.000Z", latestImage.id);
    database.connection.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run("2026-07-26T00:03:00.000Z", video.id);

    expect(store.latestStoryboardJobs([])).toEqual([]);
    expect(store.latestStoryboardJobs([7, 7]).map(({ id }) => id).sort()).toEqual([latestImage.id, video.id].sort());
  });

  it("bounds job event reads to the latest records while preserving chronological order", () => {
    store.enqueue("bounded-events", {}, "bounded-events");
    store.appendEvent("bounded-events", "info", "event one");
    store.appendEvent("bounded-events", "info", "event two");
    store.appendEvent("bounded-events", "info", "event three");

    expect(store.events("bounded-events", 2).map(({ message }) => message)).toEqual(["event two", "event three"]);
    expect(store.events("bounded-events")).toHaveLength(4);
    expect(() => store.events("bounded-events", 0)).toThrow(/positive integer/);
  });

  it("commits job output and handler persistence in one transaction", async () => {
    const queue = new PersistentJobQueue(store);
    queue.register("atomic", (_input, context) => {
      context.complete({ saved: true }, () => {
        database.connection
          .prepare("INSERT INTO settings(key, value, updated_at) VALUES ('atomic-result', 'saved', 'now')")
          .run();
      });
      return { saved: true };
    });
    queue.start();

    queue.enqueue("atomic", {}, "job-atomic");
    await queue.waitForIdle(1_000);

    expect(store.require("job-atomic")).toMatchObject({ status: "done", output: { saved: true } });
    expect(database.connection.prepare("SELECT value FROM settings WHERE key = 'atomic-result'").get()).toEqual({ value: "saved" });
  });

  it("rolls back handler persistence when atomic completion fails", async () => {
    const queue = new PersistentJobQueue(store);
    queue.register("atomic-failure", (_input, context) => {
      context.complete({ saved: true }, () => {
        database.connection
          .prepare("INSERT INTO settings(key, value, updated_at) VALUES ('atomic-result', 'partial', 'now')")
          .run();
        throw new Error("simulated crash before commit");
      });
      return { saved: true };
    });
    queue.start();

    queue.enqueue("atomic-failure", {}, "job-atomic-failure");
    await queue.waitForIdle(1_000);

    expect(store.require("job-atomic-failure")).toMatchObject({ status: "error", error: "simulated crash before commit" });
    expect(database.connection.prepare("SELECT value FROM settings WHERE key = 'atomic-result'").get()).toBeUndefined();
  });

  it("recovers jobs left running by a previous process", () => {
    store.enqueue("recoverable", { source: "disk" }, "job-recover");
    database.connection
      .prepare("UPDATE jobs SET status = 'running', attempts = 1 WHERE id = ?")
      .run("job-recover");

    expect(store.recoverInterrupted()).toBe(1);
    expect(store.require("job-recover")).toMatchObject({ status: "queued", attempts: 1 });
    expect(store.events("job-recover").at(-1)?.message).toBe("Interrupted job recovered and queued");
    expect(store.recoverInterrupted()).toBe(0);
  });

  it("deduplicates blocking image and video jobs for the same storyboard", () => {
    const queue = new PersistentJobQueue(store);
    const image = queue.enqueue("image.generate", { storyboardId: 7 });
    expect(queue.enqueue("image.generate", { storyboardId: 7 }).id).toBe(image.id);
    expect(store.list()).toHaveLength(1);

    queue.pause(image.id);
    expect(queue.enqueueUniqueStoryboard("image.generate", { storyboardId: 7 }).id).toBe(image.id);
    expect(store.list()).toHaveLength(1);

    const video = queue.enqueue("video.generate", { storyboardId: 7 });
    expect(video.id).not.toBe(image.id);
    expect(queue.enqueue("video.generate", { storyboardId: 7 }).id).toBe(video.id);
    expect(store.list()).toHaveLength(2);

    queue.cancel(image.id);
    const replacement = queue.enqueue("image.generate", { storyboardId: 7 });
    expect(replacement.id).not.toBe(image.id);
    expect(store.list()).toHaveLength(3);
  });

  it("reuses running storyboard jobs and permits new work after terminal states", () => {
    const queue = new PersistentJobQueue(store);
    const running = queue.enqueue("image.generate", { storyboardId: 11 });
    database.connection.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(running.id);

    expect(queue.enqueue("image.generate", { storyboardId: 11 }).id).toBe(running.id);

    database.connection.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(running.id);
    const afterDone = queue.enqueue("image.generate", { storyboardId: 11 });
    expect(afterDone.id).not.toBe(running.id);

    database.connection.prepare("UPDATE jobs SET status = 'error' WHERE id = ?").run(afterDone.id);
    const afterError = queue.enqueue("image.generate", { storyboardId: 11 });
    expect(afterError.id).not.toBe(afterDone.id);

    const otherStoryboard = queue.enqueue("image.generate", { storyboardId: 12 });
    expect(otherStoryboard.id).not.toBe(afterError.id);
    expect(store.list()).toHaveLength(4);
  });

  it("promotes a queued storyboard job ahead of ordinary work", () => {
    const queue = new PersistentJobQueue(store);
    const ordinary = queue.enqueue("video.generate", { storyboardId: 31 });
    const promoted = queue.enqueuePriorityStoryboard("video.generate", { storyboardId: 32 });

    expect(promoted.priority).toBe(100);
    expect(store.claimNext()?.id).toBe(promoted.id);
    expect(store.claimNext()?.id).toBe(ordinary.id);
  });

  it("does not claim queued generation work for a storyboard that is already running", () => {
    const running = store.enqueue("video.generate", { storyboardId: 41 }, "running-storyboard");
    database.connection.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(running.id);
    const priority = store.enqueue("video.generate", { storyboardId: 41 }, "priority-same-storyboard", 100);
    const ordinary = store.enqueue("video.generate", { storyboardId: 42 }, "ordinary-other-storyboard");

    expect(store.claimNext()?.id).toBe(ordinary.id);
    expect(store.require(priority.id).status).toBe("queued");
    database.connection.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(running.id);
    expect(store.claimNext()?.id).toBe(priority.id);
  });

  it("starts the first ten video jobs in queue order and leaves the eleventh waiting", async () => {
    expect(DESKTOP_JOB_CONCURRENCY).toBe(10);
    const fixedStore = new JobStore(database.connection, () => "2026-07-29T00:00:00.000Z");
    const queue = new PersistentJobQueue(fixedStore, DESKTOP_JOB_CONCURRENCY);
    const inputOrder = [7, 2, 11, 4, 9, 1, 8, 5, 10, 3, 6];
    const ids = ["video-z", "video-a", "video-y", "video-b", "video-x", "video-c", "video-w", "video-d", "video-v", "video-e", "video-u"];
    const started: number[] = [];
    const finish = new Map<number, () => void>();
    queue.register<{ storyboardId: number }, void>("video.generate", ({ storyboardId }) => {
      started.push(storyboardId);
      return new Promise<void>((resolve) => finish.set(storyboardId, resolve));
    });

    for (const [position, storyboardId] of inputOrder.entries()) {
      queue.enqueue("video.generate", { storyboardId }, ids[position]);
    }
    queue.start();

    await waitUntil(() => started.length === 10);
    expect(started).toEqual(inputOrder.slice(0, 10));
    expect(ids.slice(0, 10).every((id) => fixedStore.require(id).status === "running")).toBe(true);
    expect(fixedStore.require(ids[10]!).status).toBe("queued");

    finish.get(inputOrder[0]!)?.();
    await waitUntil(() => started.length === 11);
    expect(started).toEqual(inputOrder);

    for (const storyboardId of inputOrder.slice(1)) finish.get(storyboardId)?.();
    await queue.waitForIdle(1_000);
  });

  it("finds blocking generation jobs across a set of storyboards", () => {
    store.enqueue("text.polish", { storyboardId: 21 }, "unrelated-type");
    const done = store.enqueue("image.generate", { storyboardId: 21 }, "done-image");
    database.connection.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(done.id);
    const paused = store.enqueue("video.generate", { storyboardId: 22 }, "paused-video");
    store.pause(paused.id);
    const queued = store.enqueue("image.generate", { storyboardId: 23 }, "queued-image");
    const running = store.enqueue("video.generate", { storyboardId: 24 }, "running-video");
    database.connection.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(running.id);

    expect(store.findBlockingStoryboardJobForAny([])).toBeNull();
    expect(store.findBlockingStoryboardJobForAny([21])).toBeNull();
    expect(store.findBlockingStoryboardJobForAny([21, 22])?.id).toBe(paused.id);
    expect(store.findBlockingStoryboardJobForAny([23])?.id).toBe(queued.id);
    expect(store.findBlockingStoryboardJobForAny([24])?.id).toBe(running.id);

    store.cancel(paused.id);
    expect(store.findBlockingStoryboardJobForAny([22])).toBeNull();
  });

  it("cancels a running handler without allowing it to overwrite terminal state", async () => {
    const queue = new PersistentJobQueue(store);
    queue.register("blocking", (_input, context) => {
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    });
    queue.start();
    queue.enqueue("blocking", {}, "job-cancel");
    await waitUntil(() => store.require("job-cancel").status === "running");

    expect(queue.cancel("job-cancel").status).toBe("cancelled");
    await queue.waitForIdle(1_000);

    expect(store.require("job-cancel")).toMatchObject({ status: "cancelled", progress: 0, error: null });
    expect(store.events("job-cancel").at(-1)?.message).toBe("Job cancelled");
  });

  it("pauses, resumes and retries jobs with explicit state transitions", async () => {
    const queue = new PersistentJobQueue(store);
    let resumableRuns = 0;
    let retryRuns = 0;
    queue.register("resumable", (_input, context) => {
      resumableRuns += 1;
      if (resumableRuns > 1) return "resumed";
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    });
    queue.register("flaky", () => {
      retryRuns += 1;
      if (retryRuns === 1) throw new Error("temporary failure");
      return "recovered";
    });
    queue.start();

    queue.enqueue("resumable", {}, "job-pause");
    await waitUntil(() => store.require("job-pause").status === "running");
    queue.pause("job-pause");
    await queue.waitForIdle(1_000);
    expect(store.require("job-pause").status).toBe("paused");

    queue.resume("job-pause");
    await queue.waitForIdle(1_000);
    expect(store.require("job-pause")).toMatchObject({ status: "done", output: "resumed", attempts: 2 });

    queue.enqueue("flaky", {}, "job-retry");
    await queue.waitForIdle(1_000);
    expect(store.require("job-retry")).toMatchObject({ status: "error", error: "temporary failure" });
    queue.retry("job-retry");
    await queue.waitForIdle(1_000);
    expect(store.require("job-retry")).toMatchObject({ status: "done", output: "recovered", attempts: 2 });
  });

  it("automatically pauses recoverable work with structured diagnostics and resumes it", async () => {
    const queue = new PersistentJobQueue(store);
    let runs = 0;
    queue.register("recoverable-validation", () => {
      runs += 1;
      if (runs === 1) {
        throw new PauseJobError("校验未清零，草稿已保留", {
          stage: "full-table-repair",
          workDir: "D:\\项目\\.ai-tool-inference\\job",
          reportPaths: ["D:\\项目\\dcol_validation_report.json"],
          errorCategory: "DCOL.UNCLASSIFIED",
          completedIndexes: [1, 2, 3],
        });
      }
      return { resumed: true };
    });
    queue.start();

    queue.enqueue("recoverable-validation", {}, "job-auto-pause");
    await queue.waitForIdle(1_000);

    expect(store.require("job-auto-pause")).toMatchObject({
      status: "paused",
      error: "校验未清零，草稿已保留",
      attempts: 1,
    });
    expect(store.events("job-auto-pause").at(-1)).toMatchObject({
      level: "warning",
      message: "Job paused for attention",
      detail: {
        stage: "full-table-repair",
        errorCategory: "DCOL.UNCLASSIFIED",
        completedIndexes: [1, 2, 3],
      },
    });

    queue.resume("job-auto-pause");
    await queue.waitForIdle(1_000);
    expect(store.require("job-auto-pause")).toMatchObject({
      status: "done",
      output: { resumed: true },
      error: null,
      attempts: 2,
    });
  });

  it("returns running work to the queue during a clean shutdown", async () => {
    const queue = new PersistentJobQueue(store);
    queue.register("long", (_input, context) => {
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    });
    queue.start();
    queue.enqueue("long", {}, "job-shutdown");
    await waitUntil(() => store.require("job-shutdown").status === "running");

    await queue.shutdown();

    expect(store.require("job-shutdown").status).toBe("queued");
    expect(store.events("job-shutdown").at(-1)?.message).toBe("Job interrupted and queued");
  });
});
