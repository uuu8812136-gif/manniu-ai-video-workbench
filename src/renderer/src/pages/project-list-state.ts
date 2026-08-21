import type { Storyboard, WorkflowJob } from "../../../shared/contracts";

function jobProjectId(job: WorkflowJob, storyboardProjectIds: ReadonlyMap<number, number>): number | null {
  if (!job.input || typeof job.input !== "object") return null;
  const input = job.input as { projectId?: unknown; storyboardId?: unknown };
  if (Number.isInteger(input.projectId) && Number(input.projectId) > 0) return Number(input.projectId);
  if (Number.isInteger(input.storyboardId)) return storyboardProjectIds.get(Number(input.storyboardId)) ?? null;
  return null;
}

export function projectDeleteLockReason(
  projectId: number,
  storyboards: readonly Storyboard[],
  jobs: readonly WorkflowJob[],
  batchProtected: boolean,
): string | null {
  if (batchProtected) return "项目正在批量队列中等待或运行";
  const storyboardProjectIds = new Map(storyboards.map((storyboard) => [storyboard.id, storyboard.projectId]));
  const activeJob = jobs.find((job) => ["queued", "running", "paused"].includes(job.status)
    && jobProjectId(job, storyboardProjectIds) === projectId);
  if (activeJob) return activeJob.status === "paused" ? "项目有暂停中的任务" : "项目有等待或运行中的任务";
  if (storyboards.some((storyboard) => storyboard.videoSubmissionState === "submitting")) return "项目正在提交视频任务";
  if (storyboards.some((storyboard) => storyboard.videoTaskId || storyboard.videoSubmissionState === "submitted")) {
    return "项目有视频正在生成或等待下载";
  }
  return null;
}
