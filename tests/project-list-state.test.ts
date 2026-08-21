import { describe, expect, it } from "vitest";
import type { Storyboard, WorkflowJob } from "../src/shared/contracts";
import { projectDeleteLockReason } from "../src/renderer/src/pages/project-list-state";

function storyboard(input: Partial<Storyboard> = {}): Storyboard {
  return {
    id: 11,
    projectId: 7,
    videoSubmissionState: "idle",
    videoTaskId: null,
    ...input,
  } as Storyboard;
}

function job(input: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    id: "job-1",
    type: "video.generate",
    status: "running",
    input: { storyboardId: 11 },
    ...input,
  } as WorkflowJob;
}

describe("project list delete locks", () => {
  it("prioritizes the batch queue and active job locks", () => {
    expect(projectDeleteLockReason(7, [storyboard()], [], true)).toContain("批量队列");
    expect(projectDeleteLockReason(7, [storyboard()], [job()], false)).toContain("运行中");
    expect(projectDeleteLockReason(7, [storyboard()], [job({ status: "paused" })], false)).toContain("暂停中");
  });

  it("permits abnormal uncertain rows while locking active Vidu submissions", () => {
    expect(projectDeleteLockReason(7, [storyboard({ videoSubmissionState: "uncertain" })], [], false)).toBeNull();
    expect(projectDeleteLockReason(7, [storyboard({ videoSubmissionState: "submitting" })], [], false)).toContain("提交视频");
    expect(projectDeleteLockReason(7, [storyboard({ videoSubmissionState: "submitted", videoTaskId: "vidu-1" })], [], false)).toContain("等待下载");
    expect(projectDeleteLockReason(7, [storyboard()], [], false)).toBeNull();
  });

  it("recognizes project-scoped inference jobs without a storyboard id", () => {
    expect(projectDeleteLockReason(7, [storyboard()], [job({ type: "storyboard.infer", input: { projectId: 7 } })], false)).toContain("运行中");
  });
});
