import { describe, expect, it, vi } from "vitest";
import type { Storyboard, WorkflowJob, WorkflowJobStatus } from "../src/shared/contracts";
import {
  blocksNewGeneration,
  confirmVideoRegeneration,
  hasUsableViduAccount,
  needsVideoRegenerationConfirmation,
  storyboardWorkflowJob,
  summarizeBatchJobs,
  summarizeStoryboardWorkflow,
} from "../src/renderer/src/pages/workflow-job-state";

function storyboard(id: number, prompt = "画面提示词"): Storyboard {
  return { id, prompt } as Storyboard;
}

function job(id: string, type: WorkflowJob["type"], status: WorkflowJobStatus, storyboardId: number): WorkflowJob {
  return { id, type, status, input: { storyboardId } } as WorkflowJob;
}

describe("storyboard workflow page state", () => {
  it("matches only the latest job of the requested workflow type", () => {
    const jobs = [
      job("image-old", "image.generate", "done", 1),
      job("video-new", "video.generate", "running", 1),
      job("image-new", "image.generate", "paused", 1),
    ];
    expect(storyboardWorkflowJob(1, "image.generate", jobs)?.id).toBe("image-new");
    expect(storyboardWorkflowJob(1, "video.generate", jobs)?.id).toBe("video-new");
  });

  it("keeps paused storyboards out of generate-all without counting them as running", () => {
    const storyboards = [storyboard(1), storyboard(2), storyboard(3), storyboard(4, "")];
    const jobs = [
      job("running", "image.generate", "running", 1),
      job("paused", "image.generate", "paused", 2),
      job("other-type", "video.generate", "paused", 3),
    ];
    const summary = summarizeStoryboardWorkflow(storyboards, jobs, "image.generate");
    expect(summary).toMatchObject({ active: 1, paused: 1 });
    expect(summary.runnable.map((item) => item.id)).toEqual([3]);
    expect(blocksNewGeneration(jobs[1])).toBe(true);
  });

  it("reports running, paused, and failed batch counts separately", () => {
    const jobs = [
      job("queued", "image.generate", "queued", 1),
      job("running", "video.generate", "running", 2),
      job("paused", "video.generate", "paused", 3),
      job("error", "image.generate", "error", 4),
      job("done", "image.generate", "done", 5),
    ];
    expect(summarizeBatchJobs(jobs)).toEqual({ active: 2, paused: 1, errors: 1 });
  });

  it("keeps completed videos out of generate-all and requires explicit regeneration", () => {
    const completed = { ...storyboard(1), videoPath: "D:\\videos\\storyboard-1.mp4" } as Storyboard;
    const pending = { ...storyboard(2), videoPath: null } as Storyboard;

    expect(summarizeStoryboardWorkflow([completed, pending], [], "video.generate").runnable.map(({ id }) => id))
      .toEqual([2]);
    expect(summarizeStoryboardWorkflow([completed, pending], [], "image.generate").runnable.map(({ id }) => id))
      .toEqual([1, 2]);
    expect(needsVideoRegenerationConfirmation(completed)).toBe(true);
    expect(needsVideoRegenerationConfirmation(pending)).toBe(false);

    const confirm = vi.fn(() => false);
    expect(confirmVideoRegeneration(pending, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(confirmVideoRegeneration(completed, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("再次消耗额度或积分"));
  });

  it("requires an enabled Vidu account with remaining quota for new submissions", () => {
    const base = { enabled: true, disabledReason: null, defaultQuota: 10, usageCount: 3 };
    expect(hasUsableViduAccount([{ ...base, id: "ready" } as never])).toBe(true);
    expect(hasUsableViduAccount([{ ...base, id: "disabled", enabled: false } as never])).toBe(false);
    expect(hasUsableViduAccount([{ ...base, id: "spent", usageCount: 10 } as never])).toBe(false);
    expect(hasUsableViduAccount([{ ...base, id: "expired", disabledReason: "login_expired" } as never])).toBe(false);
  });
});
