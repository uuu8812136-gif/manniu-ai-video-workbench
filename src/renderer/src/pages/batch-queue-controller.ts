import type { Project, Storyboard, WorkflowJob } from "../../../shared/contracts";
import {
  activeProjectVideoJobs,
  activeBatchStartConflicts,
  addProjectsToBatchQueue,
  batchQueueCompletionMessage,
  batchStartConflictMessage,
  clearFinishedBatchQueueEntries,
  latestVideoJobByStoryboard,
  isBatchQueueProjectProtected,
  moveBatchQueueEntry,
  reorderBatchQueueEntry,
  removeBatchQueueEntries,
  restoreBatchQueueSnapshot,
  type BatchQueueEntry,
  type BatchQueueSnapshot,
  type BatchQueueStatus,
} from "./batch-queue-state";

const STORAGE_KEY = "ai-tool.batch-queue.v1";
const POLL_INTERVAL_MS = 1_000;
const WATCHDOG_CHECK_INTERVAL_MS = 15_000;
const NO_PROGRESS_TIMEOUT_MS = 20 * 60 * 1_000;

type Listener = (snapshot: BatchQueueSnapshot) => void;

function identifier(): string {
  return globalThis.crypto?.randomUUID?.() ?? `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readSnapshot(): BatchQueueSnapshot {
  return restoreBatchQueueSnapshot(storage()?.getItem(STORAGE_KEY) ?? null);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

class BatchQueueController {
  private snapshot = readSnapshot();
  private readonly listeners = new Set<Listener>();
  private scheduleTimer: number | null = null;
  private runPromise: Promise<void> | null = null;
  private stopRequested = false;
  private skipRequested = false;
  private starting = false;

  getSnapshot(): BatchQueueSnapshot {
    return this.snapshot;
  }

  isProjectProtected(projectId: number): boolean {
    return isBatchQueueProjectProtected(this.snapshot.entries, projectId);
  }

  activate(): void {
    this.armSchedule();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    this.armSchedule();
    return () => this.listeners.delete(listener);
  }

  addProjects(projects: Project[]): void {
    this.commit({ entries: addProjectsToBatchQueue(this.snapshot.entries, projects, new Date(), identifier) });
  }

  move(id: string, direction: -1 | 1): void {
    if (this.snapshot.running) return;
    this.commit({ entries: moveBatchQueueEntry(this.snapshot.entries, id, direction) });
  }

  reorder(id: string, targetId: string): void {
    if (this.snapshot.running) return;
    this.commit({ entries: reorderBatchQueueEntry(this.snapshot.entries, id, targetId) });
  }

  remove(ids: Iterable<string>): void {
    this.commit({ entries: removeBatchQueueEntries(this.snapshot.entries, ids) });
  }

  clearFinished(): void {
    this.commit({ entries: clearFinishedBatchQueueEntries(this.snapshot.entries) });
  }

  retry(id: string): void {
    if (this.snapshot.running) return;
    const updatedAt = new Date().toISOString();
    this.commit({
      entries: this.snapshot.entries.map((entry) => entry.id === id && entry.status === "error"
        ? { ...entry, status: "waiting", error: null, updatedAt }
        : entry),
    });
  }

  schedule(at: number | null): void {
    const scheduledAt = at !== null && Number.isFinite(at) && at > Date.now() ? at : null;
    this.commit({ scheduledAt });
    this.armSchedule();
  }

  async start(options: { rescheduleOnConflict?: boolean } = {}): Promise<void> {
    if (this.runPromise || this.snapshot.running || this.starting) return;
    if (!this.snapshot.entries.some((entry) => entry.status === "waiting")) {
      if (this.snapshot.scheduledAt !== null) this.commit({ scheduledAt: null });
      return;
    }
    this.starting = true;
    try {
      const conflicts = activeBatchStartConflicts(await window.offline.jobs.list());
      if (conflicts.length > 0) {
        if (options.rescheduleOnConflict) {
          this.commit({ scheduledAt: Date.now() + 60_000 });
          this.armSchedule();
          return;
        }
        throw new Error(batchStartConflictMessage(conflicts));
      }
      this.stopRequested = false;
      this.skipRequested = false;
      this.commit({ running: true, scheduledAt: null });
      this.runPromise = this.run().then(async (completed) => {
        if (completed) {
          await window.offline.notifications.notify("batch", batchQueueCompletionMessage(this.snapshot.entries)).catch(() => false);
        }
      }).finally(() => {
        this.runPromise = null;
        this.stopRequested = false;
        this.skipRequested = false;
        this.commit({ running: false, currentProjectId: null });
      });
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    if (!this.snapshot.running) return;
    this.stopRequested = true;
    await this.cancelCurrentProjectJobs();
  }

  async skipCurrent(): Promise<void> {
    if (!this.snapshot.running || this.snapshot.currentProjectId === null) return;
    this.skipRequested = true;
    await this.cancelCurrentProjectJobs();
  }

  private commit(patch: Partial<BatchQueueSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, version: 1 };
    try {
      storage()?.setItem(STORAGE_KEY, JSON.stringify(this.snapshot));
    } catch {
      // The queue remains usable for this session when storage is unavailable.
    }
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private updateEntry(id: string, status: BatchQueueStatus, error: string | null = null): void {
    const updatedAt = new Date().toISOString();
    this.commit({
      entries: this.snapshot.entries.map((entry) => entry.id === id ? { ...entry, status, error, updatedAt } : entry),
    });
  }

  private armSchedule(): void {
    if (this.scheduleTimer !== null) window.clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    if (this.snapshot.running || this.snapshot.scheduledAt === null) return;
    const delay = Math.max(0, this.snapshot.scheduledAt - Date.now());
    this.scheduleTimer = window.setTimeout(() => {
      this.scheduleTimer = null;
      if (this.snapshot.scheduledAt !== null && this.snapshot.scheduledAt > Date.now() + 250) this.armSchedule();
      else void this.start({ rescheduleOnConflict: true }).catch((reason) => window.alert(reason instanceof Error ? reason.message : String(reason)));
    }, Math.min(delay, 2_147_483_647));
  }

  private async run(): Promise<boolean> {
    for (;;) {
      if (this.stopRequested) return false;
      const entry = this.snapshot.entries.find((item) => item.status === "waiting");
      if (!entry) return true;
      this.commit({ currentProjectId: entry.projectId });
      this.updateEntry(entry.id, "running");
      try {
        const result = await this.runProject(entry);
        if (result === "stopped") {
          this.updateEntry(entry.id, "waiting");
          return false;
        }
        if (result === "skipped") {
          this.updateEntry(entry.id, "skipped");
          this.skipRequested = false;
          continue;
        }
        this.updateEntry(entry.id, "done");
      } catch (reason) {
        this.updateEntry(entry.id, "error", reason instanceof Error ? reason.message : String(reason));
      }
    }
  }

  private async runProject(entry: BatchQueueEntry): Promise<"done" | "skipped" | "stopped"> {
    let storyboards = await window.offline.storyboards.list(entry.projectId);
    if (storyboards.length === 0) throw new Error("项目没有分镜");
    let jobs = await window.offline.jobs.list();
    const latest = latestVideoJobByStoryboard(storyboards, jobs);
    let submitted = 0;

    for (const storyboard of storyboards) {
      if (storyboard.videoPath?.trim()) continue;
      if (storyboard.videoSubmissionState === "submitted") continue;
      if (storyboard.videoSubmissionState === "uncertain") continue;
      if (!storyboard.prompt.trim()) continue;
      const job = latest.get(storyboard.id);
      if (job?.status === "paused") {
        await window.offline.jobs.resume(job.id);
        submitted += 1;
      } else if (job?.status === "queued" || job?.status === "running") {
        submitted += 1;
      } else if (job?.status === "error") {
        await window.offline.jobs.retry(job.id);
        submitted += 1;
      } else {
        await window.offline.jobs.enqueue("video.generate", { storyboardId: storyboard.id });
        submitted += 1;
      }
    }

    if (submitted === 0) {
      if (this.allTargetsCompleted(storyboards)) return "done";
      throw new Error(this.projectProblem(storyboards, jobs));
    }

    let progressSignature = this.projectProgressSignature(storyboards, jobs);
    let lastProgressAt = Date.now();
    let lastWatchdogCheckAt = lastProgressAt;
    for (;;) {
      if (this.stopRequested) return "stopped";
      if (this.skipRequested) return "skipped";
      await wait(POLL_INTERVAL_MS);
      [storyboards, jobs] = await Promise.all([
        window.offline.storyboards.list(entry.projectId),
        window.offline.jobs.list(),
      ]);
      if (this.stopRequested) return "stopped";
      if (this.skipRequested) return "skipped";
      const now = Date.now();
      const nextSignature = this.projectProgressSignature(storyboards, jobs);
      if (nextSignature !== progressSignature) {
        progressSignature = nextSignature;
        lastProgressAt = now;
      }
      if (this.allTargetsCompleted(storyboards)) return "done";
      const active = activeProjectVideoJobs(storyboards, jobs);
      if (active.length === 0) throw new Error(this.projectProblem(storyboards, jobs));
      if (now - lastWatchdogCheckAt >= WATCHDOG_CHECK_INTERVAL_MS) {
        lastWatchdogCheckAt = now;
        if (now - lastProgressAt >= NO_PROGRESS_TIMEOUT_MS) {
          await this.cancelCurrentProjectJobs();
          return "skipped";
        }
      }
    }
  }

  private allTargetsCompleted(storyboards: Storyboard[]): boolean {
    return storyboards.every((storyboard) => Boolean(storyboard.videoPath?.trim()));
  }

  private projectProgressSignature(storyboards: Storyboard[], jobs: WorkflowJob[]): string {
    const latest = latestVideoJobByStoryboard(storyboards, jobs);
    return storyboards.map((storyboard) => {
      const job = latest.get(storyboard.id);
      return [
        storyboard.id,
        storyboard.videoPath?.trim() ? "downloaded" : "pending",
        storyboard.videoSubmissionState,
        storyboard.videoTaskId ?? "",
        job?.id ?? "",
        job?.status ?? "",
        job?.progress ?? "",
      ].join(":");
    }).join("|");
  }

  private projectProblem(storyboards: Storyboard[], jobs: WorkflowJob[]): string {
    const latest = latestVideoJobByStoryboard(storyboards, jobs);
    const uncertain = storyboards.filter((storyboard) => storyboard.videoSubmissionState === "uncertain").length;
    const missingPrompt = storyboards.filter((storyboard) => !storyboard.videoPath?.trim() && !storyboard.prompt.trim()).length;
    const failures = storyboards.flatMap((storyboard) => {
      if (storyboard.videoPath?.trim()) return [];
      const job = latest.get(storyboard.id);
      return job?.status === "error" ? [job.error || `分镜 ${storyboard.index + 1} 失败`] : [];
    });
    if (uncertain > 0) return `${uncertain} 个分镜提交状态待人工确认`;
    if (failures[0]) return failures[0];
    if (missingPrompt > 0) return `${missingPrompt} 个分镜缺少画面提示词`;
    return "仍有视频未生成，且没有可继续执行的任务";
  }

  private async cancelCurrentProjectJobs(): Promise<void> {
    const projectId = this.snapshot.currentProjectId;
    if (projectId === null) return;
    const [storyboards, jobs] = await Promise.all([
      window.offline.storyboards.list(projectId),
      window.offline.jobs.list(),
    ]);
    await Promise.all(activeProjectVideoJobs(storyboards, jobs).map((job) => window.offline.jobs.cancel(job.id).catch(() => undefined)));
  }
}

export const batchQueueController = new BatchQueueController();

export function batchQueueStorageKey(): string {
  return STORAGE_KEY;
}
