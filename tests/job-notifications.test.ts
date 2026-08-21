import { describe, expect, it, vi } from "vitest";
import type { JobRecord } from "../src/main/jobs";
import { createJobNotificationHandler, jobNotification } from "../src/main/job-notifications";

function job(patch: Partial<JobRecord>): JobRecord {
  return {
    id: "job",
    type: "video.generate",
    status: "done",
    progress: 100,
    input: { storyboardId: 3 },
    output: null,
    error: null,
    attempts: 1,
    priority: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    ...patch,
  };
}

describe("job webhook notifications", () => {
  const projects = { get: () => ({ name: "项目 A" }) };
  const completeStoryboards = {
    get: () => ({ id: 3, projectId: 8 }),
    list: () => [{ videoPath: "a.mp4" }, { videoPath: "b.mp4" }],
  };

  it("classifies errors without including job inputs", () => {
    expect(jobNotification(job({ status: "error", error: "积分不足", input: { apiKey: "secret" } }), projects as never, completeStoryboards as never))
      .toEqual({ event: "quota", content: "video.generate 任务失败：积分不足" });
    expect(jobNotification(job({ status: "error", error: "队列已满" }), projects as never, completeStoryboards as never)?.event).toBe("throttle");
    expect(jobNotification(job({ status: "error", error: "下载失败" }), projects as never, completeStoryboards as never)?.event).toBe("error");
  });

  it("only emits completion when all project videos exist", () => {
    expect(jobNotification(job({}), projects as never, completeStoryboards as never)).toEqual({
      event: "complete",
      content: "项目“项目 A”的 2 个分镜已全部完成",
    });
    expect(jobNotification(job({}), projects as never, { ...completeStoryboards, list: () => [{ videoPath: null }] } as never)).toBeNull();
  });

  it("delivers derived terminal notifications", () => {
    const notify = vi.fn(async () => true);
    const handler = createJobNotificationHandler({ notifier: { notify }, projects: projects as never, storyboards: completeStoryboards as never });
    handler(job({}));
    expect(notify).toHaveBeenCalledWith("complete", "项目“项目 A”的 2 个分镜已全部完成");
  });
});
