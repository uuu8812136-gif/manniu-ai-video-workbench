import type { JobRecord, JobStatus } from "./jobs";

export type ActiveJobSummary = Record<Extract<JobStatus, "queued" | "running" | "paused">, number> & {
  total: number;
};

const ACTIVE_STATUSES = new Set<JobStatus>(["queued", "running", "paused"]);

export function summarizeActiveJobs(jobs: Array<Pick<JobRecord, "status">>): ActiveJobSummary {
  const summary: ActiveJobSummary = { queued: 0, running: 0, paused: 0, total: 0 };
  for (const job of jobs) {
    if (!ACTIVE_STATUSES.has(job.status)) continue;
    summary[job.status as "queued" | "running" | "paused"] += 1;
    summary.total += 1;
  }
  return summary;
}

export function activeJobQuitDetail(summary: ActiveJobSummary): string {
  const parts = [
    summary.running > 0 ? `运行中 ${summary.running}` : "",
    summary.queued > 0 ? `排队中 ${summary.queued}` : "",
    summary.paused > 0 ? `已暂停 ${summary.paused}` : "",
  ].filter(Boolean);
  return `还有 ${summary.total} 个未结束任务（${parts.join("，")}）。退出后本地任务状态会保留，已提交到网站的任务可能继续运行。`;
}
