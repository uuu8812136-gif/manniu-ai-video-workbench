import { describe, expect, it } from "vitest";
import type { Project, Storyboard, WorkflowJob } from "../src/shared/contracts";
import {
  activeBatchStartConflicts,
  batchStartConflictMessage,
  addProjectsToBatchQueue,
  batchQueueCompletionMessage,
  batchQueueCounts,
  canReorderBatchQueueEntry,
  clearFinishedBatchQueueEntries,
  latestVideoJobByStoryboard,
  isBatchQueueProjectProtected,
  moveBatchQueueEntry,
  reorderBatchQueueEntry,
  removableBatchQueueEntryIds,
  removeBatchQueueEntries,
  restoreBatchQueueSnapshot,
  summarizeBatchProject,
  type BatchQueueEntry,
} from "../src/renderer/src/pages/batch-queue-state";

const timestamp = "2026-07-26T00:00:00.000Z";

function project(id: number, name = `项目 ${id}`): Project {
  return { id, name } as Project;
}

function entry(id: string, projectId: number, status: BatchQueueEntry["status"] = "waiting"): BatchQueueEntry {
  return { id, projectId, projectName: `项目 ${projectId}`, status, error: null, createdAt: timestamp, updatedAt: timestamp };
}

function storyboard(id: number, videoPath: string | null = null): Storyboard {
  return { id, index: id - 1, prompt: "画面", videoPath, videoSubmissionState: "idle" } as Storyboard;
}

function job(id: string, storyboardId: number, status: WorkflowJob["status"], progress = 0): WorkflowJob {
  return { id, type: "video.generate", status, progress, input: { storyboardId } } as WorkflowJob;
}

describe("batch queue state", () => {
  it("blocks project queue startup while any global work is active", () => {
    const active = [job("running-video", 1, "running", 20), job("paused-video", 2, "paused", 10)];
    const done = job("done-video", 3, "done", 100);
    expect(activeBatchStartConflicts([...active, done]).map(({ id }) => id)).toEqual(["running-video", "paused-video"]);
    expect(batchStartConflictMessage(active)).toContain("视频生成");
  });
  it("adds only projects that are not already waiting or running", () => {
    const result = addProjectsToBatchQueue(
      [entry("existing", 1), entry("old", 2, "done")],
      [project(1), project(2), project(3)],
      new Date(timestamp),
      (() => { let index = 0; return () => `new-${++index}`; })(),
    );
    expect(result.map(({ projectId, status }) => [projectId, status])).toEqual([
      [1, "waiting"],
      [2, "done"],
      [2, "waiting"],
      [3, "waiting"],
    ]);
  });

  it("moves waiting entries without crossing a running entry", () => {
    const values = [entry("a", 1), entry("running", 2, "running"), entry("b", 3), entry("c", 4)];
    expect(moveBatchQueueEntry(values, "b", -1)).toBe(values);
    expect(moveBatchQueueEntry(values, "b", 1).map(({ id }) => id)).toEqual(["a", "running", "c", "b"]);
  });

  it("reorders waiting entries by drag target within the same waiting segment", () => {
    const values = [entry("a", 1), entry("b", 2), entry("c", 3), entry("d", 4)];
    expect(canReorderBatchQueueEntry(values, "a", "c")).toBe(true);
    expect(reorderBatchQueueEntry(values, "a", "c").map(({ id }) => id)).toEqual(["b", "c", "a", "d"]);
    expect(reorderBatchQueueEntry(values, "d", "b").map(({ id }) => id)).toEqual(["a", "d", "b", "c"]);
  });

  it("does not drag running entries or reorder across a running boundary", () => {
    const values = [entry("a", 1), entry("running", 2, "running"), entry("b", 3), entry("c", 4)];
    expect(canReorderBatchQueueEntry(values, "running", "a")).toBe(false);
    expect(canReorderBatchQueueEntry(values, "a", "b")).toBe(false);
    expect(reorderBatchQueueEntry(values, "running", "a")).toBe(values);
    expect(reorderBatchQueueEntry(values, "a", "b")).toBe(values);
  });

  it("never removes a running entry and clears all terminal entries", () => {
    const values = [entry("waiting", 1), entry("running", 2, "running"), entry("done", 3, "done"), entry("error", 4, "error")];
    expect(removeBatchQueueEntries(values, ["waiting", "running"]).map(({ id }) => id)).toEqual(["running", "done", "error"]);
    expect(clearFinishedBatchQueueEntries(values).map(({ id }) => id)).toEqual(["waiting", "running"]);
    expect(removableBatchQueueEntryIds(values)).toEqual(["waiting", "done", "error"]);
  });

  it("protects projects that are waiting or running in the batch queue", () => {
    const values = [entry("waiting", 1), entry("running", 2, "running"), entry("done", 3, "done")];
    expect(isBatchQueueProjectProtected(values, 1)).toBe(true);
    expect(isBatchQueueProjectProtected(values, 2)).toBe(true);
    expect(isBatchQueueProjectProtected(values, 3)).toBe(false);
    expect(isBatchQueueProjectProtected(values, 4)).toBe(false);
  });

  it("recovers an interrupted running queue as waiting", () => {
    const restored = restoreBatchQueueSnapshot(JSON.stringify({
      version: 1,
      entries: [{ ...entry("running", 1, "running"), error: "old" }],
      running: true,
      currentProjectId: 1,
      scheduledAt: 123,
    }));
    expect(restored).toMatchObject({ running: false, currentProjectId: null, scheduledAt: 123 });
    expect(restored.entries[0]).toMatchObject({ status: "waiting", error: null });
  });

  it("uses the latest video job per storyboard and derives project progress", () => {
    const storyboards = [storyboard(1, "D:\\one.mp4"), storyboard(2), storyboard(3), storyboard(4)];
    const jobs = [
      job("old", 2, "error", 100),
      job("new", 2, "running", 35),
      job("paused", 3, "paused", 40),
      job("error", 4, "error", 10),
    ];
    expect(latestVideoJobByStoryboard(storyboards, jobs).get(2)?.id).toBe("new");
    expect(summarizeBatchProject(storyboards, jobs)).toEqual({ total: 4, done: 1, active: 1, paused: 1, errors: 1, percent: 25 });
  });

  it("summarizes a completed project queue for notifications", () => {
    expect(batchQueueCompletionMessage([
      entry("done", 1, "done"),
      entry("skipped", 2, "skipped"),
      entry("error", 3, "error"),
    ])).toBe("批量队列执行结束：完成 1 个，跳过 1 个，失败 1 个");
    expect(batchQueueCounts([
      entry("done", 1, "done"),
      entry("skipped", 2, "skipped"),
      entry("error", 3, "error"),
    ])).toEqual({ waiting: 0, running: 0, done: 1, skipped: 1, errors: 1 });
  });
});
