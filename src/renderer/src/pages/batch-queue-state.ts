import type { Project, Storyboard, WorkflowJob } from "../../../shared/contracts";

export type BatchQueueStatus = "waiting" | "running" | "done" | "skipped" | "error";

export type BatchQueueEntry = {
  id: string;
  projectId: number;
  projectName: string;
  status: BatchQueueStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BatchQueueSnapshot = {
  version: 1;
  entries: BatchQueueEntry[];
  running: boolean;
  currentProjectId: number | null;
  scheduledAt: number | null;
};

export type BatchProjectProgress = {
  total: number;
  done: number;
  active: number;
  paused: number;
  errors: number;
  percent: number;
};

const TERMINAL_STATUSES = new Set<BatchQueueStatus>(["done", "skipped", "error"]);
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);

export function emptyBatchQueueSnapshot(): BatchQueueSnapshot {
  return { version: 1, entries: [], running: false, currentProjectId: null, scheduledAt: null };
}

function validStatus(value: unknown): value is BatchQueueStatus {
  return value === "waiting" || value === "running" || value === "done" || value === "skipped" || value === "error";
}

export function restoreBatchQueueSnapshot(value: string | null): BatchQueueSnapshot {
  if (!value) return emptyBatchQueueSnapshot();
  try {
    const parsed = JSON.parse(value) as Partial<BatchQueueSnapshot>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return emptyBatchQueueSnapshot();
    const entries = parsed.entries.flatMap((item): BatchQueueEntry[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<BatchQueueEntry>;
      if (
        typeof candidate.id !== "string"
        || !Number.isInteger(candidate.projectId)
        || Number(candidate.projectId) < 1
        || typeof candidate.projectName !== "string"
        || !validStatus(candidate.status)
      ) return [];
      const recoveredStatus = candidate.status === "running" ? "waiting" : candidate.status;
      return [{
        id: candidate.id,
        projectId: Number(candidate.projectId),
        projectName: candidate.projectName,
        status: recoveredStatus,
        error: recoveredStatus === "waiting" ? null : typeof candidate.error === "string" ? candidate.error : null,
        createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
        updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
      }];
    });
    const scheduledAt = typeof parsed.scheduledAt === "number" && Number.isFinite(parsed.scheduledAt)
      ? parsed.scheduledAt
      : null;
    return { version: 1, entries, running: false, currentProjectId: null, scheduledAt };
  } catch {
    return emptyBatchQueueSnapshot();
  }
}

export function addProjectsToBatchQueue(
  entries: BatchQueueEntry[],
  projects: Project[],
  now = new Date(),
  makeId: () => string = () => crypto.randomUUID(),
): BatchQueueEntry[] {
  const present = new Set(entries.filter((entry) => entry.status === "waiting" || entry.status === "running")
    .map((entry) => entry.projectId));
  const createdAt = now.toISOString();
  const additions = projects.flatMap((project): BatchQueueEntry[] => {
    if (present.has(project.id)) return [];
    present.add(project.id);
    return [{
      id: makeId(),
      projectId: project.id,
      projectName: project.name,
      status: "waiting",
      error: null,
      createdAt,
      updatedAt: createdAt,
    }];
  });
  return [...entries, ...additions];
}

export function moveBatchQueueEntry(entries: BatchQueueEntry[], id: string, direction: -1 | 1): BatchQueueEntry[] {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0 || entries[index]?.status !== "waiting") return entries;
  const target = index + direction;
  if (target < 0 || target >= entries.length || entries[target]?.status !== "waiting") return entries;
  const next = [...entries];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function canReorderBatchQueueEntry(entries: BatchQueueEntry[], id: string, targetId: string): boolean {
  const index = entries.findIndex((entry) => entry.id === id);
  const target = entries.findIndex((entry) => entry.id === targetId);
  if (index < 0 || target < 0 || index === target) return false;
  const start = Math.min(index, target);
  const end = Math.max(index, target);
  return entries.slice(start, end + 1).every((entry) => entry.status === "waiting");
}

export function reorderBatchQueueEntry(entries: BatchQueueEntry[], id: string, targetId: string): BatchQueueEntry[] {
  if (!canReorderBatchQueueEntry(entries, id, targetId)) return entries;
  const index = entries.findIndex((entry) => entry.id === id);
  const target = entries.findIndex((entry) => entry.id === targetId);
  const next = [...entries];
  const [entry] = next.splice(index, 1);
  next.splice(target, 0, entry!);
  return next;
}

export function removeBatchQueueEntries(entries: BatchQueueEntry[], ids: Iterable<string>): BatchQueueEntry[] {
  const accepted = new Set(ids);
  return entries.filter((entry) => entry.status === "running" || !accepted.has(entry.id));
}

export function removableBatchQueueEntryIds(entries: BatchQueueEntry[]): string[] {
  return entries.filter((entry) => entry.status !== "running").map((entry) => entry.id);
}

export function isBatchQueueProjectProtected(entries: BatchQueueEntry[], projectId: number): boolean {
  return entries.some((entry) => entry.projectId === projectId && (entry.status === "waiting" || entry.status === "running"));
}

export function clearFinishedBatchQueueEntries(entries: BatchQueueEntry[]): BatchQueueEntry[] {
  return entries.filter((entry) => !TERMINAL_STATUSES.has(entry.status));
}

export function workflowStoryboardId(job: WorkflowJob): number | null {
  if (!job.input || typeof job.input !== "object") return null;
  const value = (job.input as { storyboardId?: unknown }).storyboardId;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function projectVideoJobs(storyboards: Storyboard[], jobs: WorkflowJob[]): WorkflowJob[] {
  const storyboardIds = new Set(storyboards.map((storyboard) => storyboard.id));
  return jobs.filter((job) => job.type === "video.generate" && storyboardIds.has(workflowStoryboardId(job) ?? -1));
}

export function latestVideoJobByStoryboard(storyboards: Storyboard[], jobs: WorkflowJob[]): Map<number, WorkflowJob> {
  const accepted = new Set(storyboards.map((storyboard) => storyboard.id));
  const result = new Map<number, WorkflowJob>();
  for (const job of jobs) {
    if (job.type !== "video.generate") continue;
    const storyboardId = workflowStoryboardId(job);
    if (storyboardId !== null && accepted.has(storyboardId)) result.set(storyboardId, job);
  }
  return result;
}

export function summarizeBatchProject(storyboards: Storyboard[], jobs: WorkflowJob[]): BatchProjectProgress {
  const latest = latestVideoJobByStoryboard(storyboards, jobs);
  let done = 0;
  let active = 0;
  let paused = 0;
  let errors = 0;
  for (const storyboard of storyboards) {
    const job = latest.get(storyboard.id);
    if (storyboard.videoPath?.trim()) done += 1;
    else if (job?.status === "queued" || job?.status === "running") active += 1;
    else if (job?.status === "paused") paused += 1;
    else if (job?.status === "error" || storyboard.videoSubmissionState === "uncertain") errors += 1;
  }
  const total = storyboards.length;
  return { total, done, active, paused, errors, percent: total === 0 ? 0 : Math.round(done / total * 100) };
}

export function batchQueueCounts(entries: BatchQueueEntry[]): { waiting: number; running: number; done: number; skipped: number; errors: number } {
  return {
    waiting: entries.filter((entry) => entry.status === "waiting").length,
    running: entries.filter((entry) => entry.status === "running").length,
    done: entries.filter((entry) => entry.status === "done").length,
    skipped: entries.filter((entry) => entry.status === "skipped").length,
    errors: entries.filter((entry) => entry.status === "error").length,
  };
}

export function batchQueueCompletionMessage(entries: BatchQueueEntry[]): string {
  const done = entries.filter((entry) => entry.status === "done").length;
  const skipped = entries.filter((entry) => entry.status === "skipped").length;
  const errors = entries.filter((entry) => entry.status === "error").length;
  return `批量队列执行结束：完成 ${done} 个，跳过 ${skipped} 个，失败 ${errors} 个`;
}

export function activeProjectVideoJobs(storyboards: Storyboard[], jobs: WorkflowJob[]): WorkflowJob[] {
  return projectVideoJobs(storyboards, jobs).filter((job) => ACTIVE_JOB_STATUSES.has(job.status) || job.status === "paused");
}

export function activeBatchStartConflicts(jobs: WorkflowJob[]): WorkflowJob[] {
  return jobs.filter((job) => ["queued", "running", "paused"].includes(job.status));
}

export function batchStartConflictMessage(jobs: WorkflowJob[]): string {
  const labels: Record<string, string> = {
    "opening.optimize": "开头优化",
    "text.polish": "文本润色",
    "storyboard.infer": "小说转分镜",
    "image.generate": "图片生成",
    "image.standalone": "图片工作台生成",
    "video.generate": "视频生成",
  };
  const conflicts = activeBatchStartConflicts(jobs);
  const types = [...new Set(conflicts.map((job) => labels[job.type] ?? job.type))];
  return `当前仍有 ${conflicts.length} 个全局任务未结束（${types.join("、")}），请先完成、取消或停止后再启动项目队列`;
}
