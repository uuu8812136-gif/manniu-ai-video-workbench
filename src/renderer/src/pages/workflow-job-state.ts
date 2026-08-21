import type { Storyboard, ViduAccount, WorkflowJob } from "../../../shared/contracts";

export type StoryboardWorkflowType = "image.generate" | "video.generate";

const BLOCKING_STATUSES = new Set(["queued", "running", "paused"]);

function storyboardId(job: WorkflowJob): number | null {
  if (!job.input || typeof job.input !== "object") return null;
  const value = (job.input as { storyboardId?: unknown }).storyboardId;
  return typeof value === "number" ? value : null;
}

export function storyboardWorkflowJob(
  id: number,
  type: StoryboardWorkflowType,
  jobs: WorkflowJob[],
): WorkflowJob | null {
  return [...jobs].reverse().find((job) => job.type === type && storyboardId(job) === id) ?? null;
}

export function blocksNewGeneration(job: WorkflowJob | null): boolean {
  return Boolean(job && BLOCKING_STATUSES.has(job.status));
}

export function needsVideoRegenerationConfirmation(storyboard: Storyboard): boolean {
  return Boolean(storyboard.videoPath?.trim());
}

export function confirmVideoRegeneration(
  storyboard: Storyboard,
  confirm: (message: string) => boolean,
): boolean {
  if (!needsVideoRegenerationConfirmation(storyboard)) return true;
  return confirm(`分镜 ${storyboard.index + 1} 已有视频。重新生成可能再次消耗额度或积分，确认继续？`);
}

export function summarizeStoryboardWorkflow(
  storyboards: Storyboard[],
  jobs: WorkflowJob[],
  type: StoryboardWorkflowType,
): { active: number; paused: number; runnable: Storyboard[] } {
  let active = 0;
  let paused = 0;
  const runnable: Storyboard[] = [];
  for (const storyboard of storyboards) {
    const job = storyboardWorkflowJob(storyboard.id, type, jobs);
    if (job?.status === "queued" || job?.status === "running") active += 1;
    if (job?.status === "paused") paused += 1;
    const videoBatchBlocked = type === "video.generate"
      && (storyboard.videoSubmissionState === "uncertain" || needsVideoRegenerationConfirmation(storyboard));
    if (storyboard.prompt.trim() && !blocksNewGeneration(job) && !videoBatchBlocked) runnable.push(storyboard);
  }
  return { active, paused, runnable };
}

export function summarizeBatchJobs(jobs: WorkflowJob[]): { active: number; paused: number; errors: number } {
  return {
    active: jobs.filter((job) => job.status === "queued" || job.status === "running").length,
    paused: jobs.filter((job) => job.status === "paused").length,
    errors: jobs.filter((job) => job.status === "error").length,
  };
}

export function hasUsableViduAccount(accounts: readonly ViduAccount[]): boolean {
  return accounts.some((account) => account.enabled
    && !account.disabledReason
    && account.defaultQuota > account.usageCount);
}
