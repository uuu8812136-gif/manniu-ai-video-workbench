import { describe, expect, it } from "vitest";
import type { Storyboard, WorkflowJob, WorkflowJobStatus, WorkflowJobType } from "../src/shared/contracts";
import { checkableVideoStoryboards, indexStoryboardJobs, storyboardDisplayState, storyboardJob } from "../src/renderer/src/pages/storyboard-display-state";

function storyboard(patch: Partial<Storyboard> = {}): Storyboard {
  return {
    id: 7,
    projectId: 2,
    index: 0,
    originalText: "scene",
    subjects: [],
    prompt: "prompt",
    duration: 4,
    status: "pending",
    taskId: null,
    videoTaskId: null,
    videoProvider: "custom-api",
    videoAccountId: null,
    videoSubmissionState: "idle",
    videoRecoveryState: "idle",
    videoRecoveryMessage: null,
    videoPath: null,
    imagePaths: [],
    submitCount: 0,
    updatedAt: "2026-07-26T00:00:00.000Z",
    ...patch,
  };
}

function job(type: WorkflowJobType, status: WorkflowJobStatus, updatedAt: string, patch: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    id: `${type}-${status}-${updatedAt}`,
    type,
    status,
    progress: 40,
    input: { storyboardId: 7 },
    output: null,
    error: status === "error" ? "provider failed" : null,
    attempts: 1,
    createdAt: updatedAt,
    updatedAt,
    ...patch,
  };
}

describe("storyboard display state", () => {
  it("covers pending, active, paused, uncertain, error and completed media states", () => {
    expect(storyboardDisplayState(storyboard(), [])).toMatchObject({ status: "pending", label: "待生成" });
    expect(storyboardDisplayState(storyboard(), [job("video.generate", "running", "2026-07-26T00:01:00Z")]))
      .toMatchObject({ status: "generating", progress: 40 });
    expect(storyboardDisplayState(storyboard(), [job("video.generate", "paused", "2026-07-26T00:01:00Z")]))
      .toMatchObject({ status: "paused", label: "已暂停" });
    expect(storyboardDisplayState(storyboard({ videoSubmissionState: "uncertain" }), []))
      .toMatchObject({ status: "uncertain" });
    expect(storyboardDisplayState(storyboard(), [job("video.generate", "error", "2026-07-26T00:01:00Z")]))
      .toMatchObject({ status: "error", detail: "provider failed" });
    expect(storyboardDisplayState(storyboard({ imagePaths: ["D:\\frame.png"] }), []))
      .toMatchObject({ status: "image-ready", label: "图片就绪", mediaKind: "image", imageIndex: 0 });
  });

  it("prefers video over images and hides an old result while regeneration is active", () => {
    const item = storyboard({ videoPath: "D:\\scene.mp4", imagePaths: ["D:\\frame.png"] });
    expect(storyboardDisplayState(item, [])).toMatchObject({ status: "done", mediaKind: "video" });
    expect(storyboardDisplayState(item, [job("video.generate", "running", "2026-07-26T00:02:00Z")]))
      .toMatchObject({ status: "generating", mediaKind: "video" });
  });

  it("matches only the latest job of the requested type", () => {
    const jobs = [
      job("video.generate", "done", "2026-07-26T00:01:00Z"),
      job("image.generate", "running", "2026-07-26T00:03:00Z"),
      job("video.generate", "error", "2026-07-26T00:02:00Z"),
    ];
    expect(storyboardJob(7, jobs, "video.generate")?.status).toBe("error");
    expect(storyboardDisplayState(storyboard(), jobs).status).toBe("generating");
  });

  it("builds and reuses one latest-job index for repeated row lookups", () => {
    const jobs = [
      job("video.generate", "done", "2026-07-26T00:01:00Z"),
      job("video.generate", "error", "2026-07-26T00:02:00Z"),
      job("image.generate", "running", "2026-07-26T00:03:00Z"),
    ];
    const first = indexStoryboardJobs(jobs);
    const second = indexStoryboardJobs(jobs);

    expect(second).toBe(first);
    expect(first.get(7)).toMatchObject({
      image: { status: "running" },
      video: { status: "error" },
      latest: { type: "image.generate" },
    });
  });

  it("keeps an old video available when regeneration fails", () => {
    const state = storyboardDisplayState(
      storyboard({ videoPath: "D:\\scene.mp4" }),
      [job("video.generate", "error", "2026-07-26T00:02:00Z")],
    );
    expect(state).toMatchObject({ status: "error", mediaKind: "video", detail: "provider failed" });
  });

  it.each([
    ["processing", "生成中", "generating"],
    ["waiting_url", "等待下载地址", "generating"],
    ["download_failed", "下载失败", "generating"],
    ["failed", "生成失败", "error"],
    ["not_found", "任务未找到", "generating"],
    ["unavailable", "暂不可用", "generating"],
  ] as const)("shows persisted %s recovery state", (videoRecoveryState, label, status) => {
    expect(storyboardDisplayState(storyboard({
      videoTaskId: "vidu-recovery-task",
      videoSubmissionState: "submitted",
      videoRecoveryState,
      videoRecoveryMessage: `detail:${videoRecoveryState}`,
    }), [])).toMatchObject({ status, label, detail: `detail:${videoRecoveryState}` });
  });

  it.each(["not_found", "unavailable"] as const)("does not show a misleading zero percent for %s recovery", (videoRecoveryState) => {
    const failedRecoveryJob = job("video.generate", "error", "2026-07-26T00:02:00Z", { progress: 0 });
    expect(storyboardDisplayState(storyboard({
      videoTaskId: "vidu-recovery-task",
      videoSubmissionState: "submitted",
      videoRecoveryState,
    }), [failedRecoveryJob])).toMatchObject({ progress: null });
  });

  it("keeps recoverable website tasks available to manual and batch checks", () => {
    const recoverable = storyboard({
      videoTaskId: "vidu-recovery-task",
      videoSubmissionState: "submitted",
      videoRecoveryState: "download_failed",
    });
    const terminal = storyboard({ id: 8, videoTaskId: "failed-task", videoRecoveryState: "failed" });
    expect(checkableVideoStoryboards([recoverable, terminal], []).map(({ id }) => id)).toEqual([7]);
  });
});
