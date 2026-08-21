import type { Storyboard, WorkflowJob, WorkflowJobStatus, WorkflowJobType } from "../../../shared/contracts";

export type StoryboardDisplayStatus = "pending" | "queued" | "generating" | "paused" | "image-ready" | "done" | "error" | "uncertain";

export type StoryboardDisplayState = {
  status: StoryboardDisplayStatus;
  label: string;
  detail: string;
  progress: number | null;
  job: WorkflowJob | null;
  mediaKind: "video" | "image" | null;
  imageIndex: number | null;
};

const ACTIVE_JOB_STATUS = new Set<WorkflowJobStatus>(["queued", "running", "paused"]);
const RECOVERABLE_VIDEO_STATES = new Set(["processing", "waiting_url", "download_failed", "not_found", "unavailable"]);

type IndexedStoryboardJobs = {
  image: WorkflowJob | null;
  video: WorkflowJob | null;
  latest: WorkflowJob | null;
};

const storyboardJobIndexCache = new WeakMap<WorkflowJob[], ReadonlyMap<number, IndexedStoryboardJobs>>();

export function indexStoryboardJobs(jobs: WorkflowJob[]): ReadonlyMap<number, IndexedStoryboardJobs> {
  const cached = storyboardJobIndexCache.get(jobs);
  if (cached) return cached;
  const index = new Map<number, IndexedStoryboardJobs>();
  for (const job of jobs) {
    if (job.type !== "image.generate" && job.type !== "video.generate") continue;
    const storyboardId = (job.input as { storyboardId?: unknown } | null)?.storyboardId;
    if (typeof storyboardId !== "number" || !Number.isSafeInteger(storyboardId)) continue;
    const entry = index.get(storyboardId) ?? { image: null, video: null, latest: null };
    const field = job.type === "image.generate" ? "image" : "video";
    if (!entry[field] || job.updatedAt > entry[field].updatedAt) entry[field] = job;
    if (!entry.latest || job.updatedAt > entry.latest.updatedAt) entry.latest = job;
    index.set(storyboardId, entry);
  }
  storyboardJobIndexCache.set(jobs, index);
  return index;
}

export function storyboardJob(
  storyboardId: number,
  jobs: WorkflowJob[],
  type?: Extract<WorkflowJobType, "image.generate" | "video.generate">,
): WorkflowJob | null {
  const entry = indexStoryboardJobs(jobs).get(storyboardId);
  if (!entry) return null;
  if (type === "image.generate") return entry.image;
  if (type === "video.generate") return entry.video;
  return entry.latest;
}

function media(storyboard: Storyboard): Pick<StoryboardDisplayState, "mediaKind" | "imageIndex"> {
  if (storyboard.videoPath) return { mediaKind: "video", imageIndex: null };
  if (storyboard.imagePaths.length > 0) return { mediaKind: "image", imageIndex: storyboard.imagePaths.length - 1 };
  return { mediaKind: null, imageIndex: null };
}

export function storyboardDisplayState(storyboard: Storyboard, jobs: WorkflowJob[]): StoryboardDisplayState {
  const videoJob = storyboardJob(storyboard.id, jobs, "video.generate");
  const imageJob = storyboardJob(storyboard.id, jobs, "image.generate");
  const latestJob = [videoJob, imageJob]
    .filter((job): job is WorkflowJob => Boolean(job))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const attachedMedia = media(storyboard);

  if (storyboard.videoSubmissionState === "uncertain") {
    return { status: "uncertain", label: "待确认", detail: "提交结果不确定，需人工确认", progress: null, job: videoJob, ...attachedMedia };
  }

  if (latestJob && ACTIVE_JOB_STATUS.has(latestJob.status)) {
    const status = latestJob.status === "paused" ? "paused" : latestJob.status === "queued" ? "queued" : "generating";
    const label = status === "paused" ? "已暂停" : status === "queued" ? "等待中" : "生成中";
    return { status, label, detail: latestJob.error ?? label, progress: latestJob.progress, job: latestJob, ...attachedMedia };
  }

  if (storyboard.videoTaskId && storyboard.videoRecoveryState !== "idle") {
    const labels = {
      processing: "生成中",
      waiting_url: "等待下载地址",
      download_failed: "下载失败",
      failed: "生成失败",
      not_found: "任务未找到",
      unavailable: "暂不可用",
    } as const;
    const state = storyboard.videoRecoveryState;
    const detail = storyboard.videoRecoveryMessage ?? labels[state];
    if (RECOVERABLE_VIDEO_STATES.has(state)) {
      const progress = state === "unavailable" || state === "not_found" ? null : videoJob?.progress ?? null;
      return { status: "generating", label: labels[state], detail, progress, job: videoJob, ...attachedMedia };
    }
    return { status: "error", label: labels[state], detail, progress: videoJob?.progress ?? null, job: videoJob, ...attachedMedia };
  }

  if (storyboard.videoTaskId || storyboard.videoSubmissionState === "submitting" || storyboard.videoSubmissionState === "submitted") {
    return { status: "generating", label: "生成中", detail: "已提交，等待结果回传", progress: videoJob?.progress ?? null, job: videoJob, ...attachedMedia };
  }

  if (videoJob?.status === "error" || (!attachedMedia.mediaKind && latestJob?.status === "error") || storyboard.status === "error") {
    const failedJob = videoJob?.status === "error" ? videoJob : latestJob?.status === "error" ? latestJob : null;
    return { status: "error", label: "失败", detail: failedJob?.error ?? "生成失败", progress: failedJob?.progress ?? null, job: failedJob, ...attachedMedia };
  }

  if (attachedMedia.mediaKind === "video") {
    return { status: "done", label: "视频完成", detail: "视频已生成", progress: 100, job: latestJob, ...attachedMedia };
  }

  if (attachedMedia.mediaKind === "image") {
    return { status: "image-ready", label: "图片就绪", detail: "图片已生成，视频尚未生成", progress: null, job: latestJob, ...attachedMedia };
  }

  if (storyboard.status === "generating") {
    return { status: "generating", label: "生成中", detail: "正在生成素材", progress: null, job: latestJob, ...attachedMedia };
  }

  return { status: "pending", label: "待生成", detail: "尚未生成画面", progress: null, job: latestJob, ...attachedMedia };
}

export function projectStoryboardJobs(storyboards: Storyboard[], jobs: WorkflowJob[]): WorkflowJob[] {
  const ids = new Set(storyboards.map((storyboard) => storyboard.id));
  return jobs.filter((job) => {
    if (job.type !== "image.generate" && job.type !== "video.generate") return false;
    return ids.has(Number((job.input as { storyboardId?: unknown } | null)?.storyboardId));
  });
}

export function checkableVideoStoryboards(storyboards: Storyboard[], jobs: WorkflowJob[]): Storyboard[] {
  return storyboards.filter((storyboard) => Boolean(storyboard.videoTaskId)
    && storyboardDisplayState(storyboard, jobs).status === "generating");
}
