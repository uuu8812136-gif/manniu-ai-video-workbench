import type { Storyboard, WorkflowJob, WorkflowJobEvent } from "../../../shared/contracts";

export type ProjectBatchStatus = "waiting" | "running" | "done" | "skipped" | "error";
export type ProjectBatchEditScope = "selected" | "editable" | "pending";

export const DEFAULT_PROJECT_BATCH_EDIT_SCOPE: ProjectBatchEditScope = "editable";

export function freshProjectBatchEditState(): {
  scope: ProjectBatchEditScope;
  findText: string;
  replaceText: string;
  duration: string;
} {
  return { scope: DEFAULT_PROJECT_BATCH_EDIT_SCOPE, findText: "", replaceText: "", duration: "" };
}

export type ProjectBatchEditPreview = {
  candidates: Storyboard[];
  targets: Storyboard[];
  skippedActive: Storyboard[];
};

export type ProjectBatchItem = {
  id: string;
  projectId: number;
  projectName: string;
  status: ProjectBatchStatus;
  error?: string;
};

export function workflowStoryboardId(job: WorkflowJob): number | null {
  if (!job.input || typeof job.input !== "object") return null;
  const value = (job.input as { storyboardId?: unknown }).storyboardId;
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

export function videoJobsForProject(storyboards: Storyboard[], jobs: WorkflowJob[]): WorkflowJob[] {
  const ids = new Set(storyboards.map((item) => item.id));
  return jobs.filter((job) => job.type === "video.generate" && ids.has(workflowStoryboardId(job) ?? -1));
}

export function missingVideoStoryboards(storyboards: Storyboard[], jobs: WorkflowJob[]): Storyboard[] {
  const blocking = new Set(
    videoJobsForProject(storyboards, jobs)
      .filter((job) => ["queued", "running", "paused"].includes(job.status))
      .map(workflowStoryboardId)
      .filter((id): id is number => id !== null),
  );
  return storyboards.filter((item) => !item.videoPath && item.videoSubmissionState !== "uncertain" && !blocking.has(item.id));
}

export function partitionVideoGenerationSelection(storyboards: Storyboard[]): {
  fresh: Storyboard[];
  existing: Storyboard[];
} {
  return storyboards.reduce<{ fresh: Storyboard[]; existing: Storyboard[] }>((selection, storyboard) => {
    selection[storyboard.videoPath?.trim() ? "existing" : "fresh"].push(storyboard);
    return selection;
  }, { fresh: [], existing: [] });
}

export function videoGenerationTargets(storyboards: Storyboard[], regenerateExisting: boolean): Storyboard[] {
  return regenerateExisting
    ? [...storyboards]
    : storyboards.filter((storyboard) => !storyboard.videoPath?.trim());
}

export type SubjectPreparationView = {
  jobId: string;
  storyboardId: number;
  current: number;
  total: number;
  name: string;
  percent: number;
};

function subjectPreparationDetail(value: unknown): Omit<SubjectPreparationView, "jobId" | "percent"> & { phase: string } | null {
  if (!value || typeof value !== "object") return null;
  const detail = value as Record<string, unknown>;
  if (detail.kind !== "subject-prep" || !["start", "progress", "end"].includes(String(detail.phase))) return null;
  if (!Number.isInteger(detail.storyboardId) || Number(detail.storyboardId) <= 0) return null;
  if (!Number.isInteger(detail.current) || Number(detail.current) < 0) return null;
  if (!Number.isInteger(detail.total) || Number(detail.total) <= 0) return null;
  return {
    phase: String(detail.phase),
    storyboardId: Number(detail.storyboardId),
    current: Math.min(Number(detail.current), Number(detail.total)),
    total: Number(detail.total),
    name: typeof detail.name === "string" ? detail.name : "",
  };
}

export function activeSubjectPreparation(
  jobs: WorkflowJob[],
  eventsByJob: Readonly<Record<string, WorkflowJobEvent[]>>,
): SubjectPreparationView | null {
  const activeJobIds = new Set(jobs
    .filter((job) => job.type === "video.generate" && ["queued", "running", "paused"].includes(job.status))
    .map((job) => job.id));
  let latest: { eventId: number; jobId: string; detail: ReturnType<typeof subjectPreparationDetail> } | null = null;
  for (const [jobId, events] of Object.entries(eventsByJob)) {
    if (!activeJobIds.has(jobId)) continue;
    const event = [...events].reverse().find((entry) => subjectPreparationDetail(entry.detail));
    if (!event) continue;
    const detail = subjectPreparationDetail(event.detail);
    if (!detail || detail.phase === "end" || (latest && latest.eventId >= event.id)) continue;
    latest = { eventId: event.id, jobId, detail };
  }
  if (!latest?.detail) return null;
  return {
    jobId: latest.jobId,
    storyboardId: latest.detail.storyboardId,
    current: latest.detail.current,
    total: latest.detail.total,
    name: latest.detail.name,
    percent: Math.round((latest.detail.current / latest.detail.total) * 100),
  };
}

export function previewProjectBatchEdit(
  storyboards: Storyboard[],
  jobs: WorkflowJob[],
  selectedIds: ReadonlySet<number>,
  scope: ProjectBatchEditScope,
  findText: string,
  changesDuration: boolean,
): ProjectBatchEditPreview {
  const candidates = storyboards.filter((storyboard) => {
    if (scope === "selected") return selectedIds.has(storyboard.id);
    if (scope === "pending") return storyboard.status === "pending" || storyboard.status === "error";
    return true;
  });
  const activeIds = new Set(
    jobs
      .filter((job) => (job.type === "image.generate" || job.type === "video.generate")
        && ["queued", "running", "paused"].includes(job.status))
      .map(workflowStoryboardId)
      .filter((id): id is number => id !== null),
  );
  const isActive = (storyboard: Storyboard): boolean => storyboard.status === "generating" || activeIds.has(storyboard.id);
  const skippedActive = candidates.filter(isActive);
  const targets = candidates.filter((storyboard) => !isActive(storyboard)
    && (changesDuration || (Boolean(findText) && storyboard.prompt.includes(findText))));
  return { candidates, targets, skippedActive };
}

export function parseProjectBatchItems(value: string | null): ProjectBatchItem[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): ProjectBatchItem[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<ProjectBatchItem>;
      if (
        typeof candidate.id !== "string"
        || !Number.isInteger(candidate.projectId)
        || Number(candidate.projectId) <= 0
        || typeof candidate.projectName !== "string"
        || !["waiting", "running", "done", "skipped", "error"].includes(candidate.status ?? "")
      ) return [];
      return [{
        id: candidate.id,
        projectId: Number(candidate.projectId),
        projectName: candidate.projectName,
        status: candidate.status === "running" ? "waiting" : candidate.status as ProjectBatchStatus,
        ...(typeof candidate.error === "string" && candidate.error ? { error: candidate.error } : {}),
      }];
    });
  } catch {
    return [];
  }
}
