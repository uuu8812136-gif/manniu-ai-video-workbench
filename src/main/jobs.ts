import { randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";

export type JobStatus = "queued" | "running" | "paused" | "done" | "error" | "cancelled";
export type JobEventLevel = "debug" | "info" | "warning" | "error";
export type StoryboardJobType = "image.generate" | "video.generate";

export const DESKTOP_JOB_CONCURRENCY = 10;

export type JobRecord<TInput = unknown, TOutput = unknown> = {
  id: string;
  type: string;
  status: JobStatus;
  progress: number;
  input: TInput;
  output: TOutput | null;
  error: string | null;
  attempts: number;
  priority: number;
  createdAt: string;
  updatedAt: string;
};

export type JobEvent<TDetail = unknown> = {
  id: number;
  jobId: string;
  level: JobEventLevel;
  message: string;
  detail: TDetail | null;
  createdAt: string;
};

export class PauseJobError extends Error {
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "PauseJobError";
    this.detail = detail;
  }
}

type JobRow = {
  id: string;
  type: string;
  status: JobStatus;
  progress: number;
  input_json: string;
  output_json: string | null;
  error: string | null;
  attempts: number;
  priority: number;
  created_at: string;
  updated_at: string;
};

type JobEventRow = {
  id: number;
  job_id: string;
  level: JobEventLevel;
  message: string;
  detail_json: string | null;
  created_at: string;
};

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    progress: row.progress,
    input: parseJson(row.input_json),
    output: parseJson(row.output_json),
    error: row.error,
    attempts: row.attempts,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: JobEventRow): JobEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    level: row.level,
    message: row.message,
    detail: parseJson(row.detail_json),
    createdAt: row.created_at,
  };
}

function assertProgress(progress: number): number {
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
    throw new RangeError(`Job progress must be between 0 and 100, received ${progress}`);
  }
  return Math.round(progress);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown job error";
}

function storyboardIdFromJob(job: Pick<JobRecord, "input">): number | null {
  if (!job.input || typeof job.input !== "object") return null;
  const storyboardId = (job.input as { storyboardId?: unknown }).storyboardId;
  return Number.isInteger(storyboardId) && Number(storyboardId) > 0 ? Number(storyboardId) : null;
}

export class JobStore {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  enqueue<TInput>(type: string, input: TInput, id: string = randomUUID(), priority = 0): JobRecord<TInput> {
    if (!type.trim()) throw new Error("Job type is required");
    if (!Number.isSafeInteger(priority)) throw new Error("Job priority must be an integer");
    const createdAt = this.now();
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO jobs(
             id, type, status, progress, input_json, attempts, priority, created_at, updated_at
           ) VALUES (?, ?, 'queued', 0, ?, 0, ?, ?, ?)`,
        )
        .run(id, type.trim(), JSON.stringify(input ?? null), priority, createdAt, createdAt);
      this.insertEvent(id, "info", "Job queued", { type: type.trim(), priority }, createdAt);
    });
    insert();
    return this.require<TInput>(id);
  }

  get<TInput = unknown, TOutput = unknown>(id: string): JobRecord<TInput, TOutput> | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? (mapJob(row) as JobRecord<TInput, TOutput>) : null;
  }

  require<TInput = unknown, TOutput = unknown>(id: string): JobRecord<TInput, TOutput> {
    const job = this.get<TInput, TOutput>(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return job;
  }

  list(status?: JobStatus): JobRecord[] {
    const rows = status
      ? (this.db
          .prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at, id")
          .all(status) as JobRow[])
      : (this.db.prepare("SELECT * FROM jobs ORDER BY created_at, id").all() as JobRow[]);
    return rows.map(mapJob);
  }

  latestStoryboardJobs(storyboardIds: Iterable<number>): JobRecord[] {
    const ids = [...new Set(storyboardIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT jobs.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY CASE WHEN json_valid(input_json)
                      THEN CAST(json_extract(input_json, '$.storyboardId') AS INTEGER)
                    END, type
                    ORDER BY updated_at DESC, id DESC
                  ) AS latest_rank
             FROM jobs
            WHERE type IN ('image.generate', 'video.generate')
              AND CASE WHEN json_valid(input_json)
                    THEN CAST(json_extract(input_json, '$.storyboardId') AS INTEGER)
                  END IN (${placeholders})
         )
         WHERE latest_rank = 1
         ORDER BY created_at, id`,
      )
      .all(...ids) as JobRow[];
    return rows.map(mapJob);
  }

  findBlockingStoryboardJob(type: StoryboardJobType, storyboardId: number): JobRecord | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE type = ? AND status IN ('queued', 'running', 'paused')
         ORDER BY created_at DESC, id DESC`,
      )
      .all(type) as JobRow[];
    return rows.map(mapJob).find((job) => {
      if (!job.input || typeof job.input !== "object") return false;
      return (job.input as { storyboardId?: unknown }).storyboardId === storyboardId;
    }) ?? null;
  }

  findQueuedStoryboardJob(type: StoryboardJobType, storyboardId: number): JobRecord | null {
    return this.list("queued").find((job) => job.type === type && storyboardIdFromJob(job) === storyboardId) ?? null;
  }

  promote(id: string, priority: number): JobRecord {
    if (!Number.isSafeInteger(priority)) throw new Error("Job priority must be an integer");
    const updatedAt = this.now();
    const result = this.db.prepare(
      "UPDATE jobs SET priority = MAX(priority, ?), updated_at = ? WHERE id = ? AND status = 'queued'",
    ).run(priority, updatedAt, id);
    if (result.changes !== 1) return this.require(id);
    this.insertEvent(id, "info", "Job moved to the front of the queue", { priority }, updatedAt);
    return this.require(id);
  }

  findBlockingStoryboardJobForAny(storyboardIds: Iterable<number>): JobRecord | null {
    const targetIds = new Set(storyboardIds);
    if (targetIds.size === 0) return null;
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE type IN ('image.generate', 'video.generate')
           AND status IN ('queued', 'running', 'paused')
         ORDER BY created_at DESC, id DESC`,
      )
      .all() as JobRow[];
    return rows.map(mapJob).find((job) => {
      if (!job.input || typeof job.input !== "object") return false;
      const storyboardId = (job.input as { storyboardId?: unknown }).storyboardId;
      return typeof storyboardId === "number" && targetIds.has(storyboardId);
    }) ?? null;
  }

  removeStoryboardHistory(storyboardIds: Iterable<number>): number {
    const targetIds = new Set(storyboardIds);
    if (targetIds.size === 0) return 0;
    const blocking = this.findBlockingStoryboardJobForAny(targetIds);
    if (blocking) {
      throw new Error(`Cannot reset project while ${blocking.type} job ${blocking.id} is ${blocking.status}`);
    }
    const ids = this.list()
      .filter((job) => job.type === "image.generate" || job.type === "video.generate")
      .filter((job) => {
        if (!job.input || typeof job.input !== "object") return false;
        const storyboardId = (job.input as { storyboardId?: unknown }).storyboardId;
        return typeof storyboardId === "number" && targetIds.has(storyboardId);
      })
      .map(({ id }) => id);
    if (ids.length === 0) return 0;
    const remove = this.db.transaction(() => {
      const removeEvents = this.db.prepare("DELETE FROM job_events WHERE job_id = ?");
      const removeJob = this.db.prepare("DELETE FROM jobs WHERE id = ?");
      for (const id of ids) {
        removeEvents.run(id);
        removeJob.run(id);
      }
    });
    remove();
    return ids.length;
  }

  events(jobId: string, limit?: number): JobEvent[] {
    if (limit === undefined) {
      return (
        this.db.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY id").all(jobId) as JobEventRow[]
      ).map(mapEvent);
    }
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Job event limit must be a positive integer");
    const rows = this.db
      .prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?")
      .all(jobId, limit) as JobEventRow[];
    return rows.reverse().map(mapEvent);
  }

  appendEvent(jobId: string, level: JobEventLevel, message: string, detail?: unknown): JobEvent {
    this.require(jobId);
    const createdAt = this.now();
    const result = this.insertEvent(jobId, level, message, detail, createdAt);
    const row = this.db.prepare("SELECT * FROM job_events WHERE id = ?").get(result) as JobEventRow;
    return mapEvent(row);
  }

  recoverInterrupted(): number {
    const recover = this.db.transaction(() => {
      const ids = (this.db.prepare("SELECT id FROM jobs WHERE status = 'running'").all() as Array<{ id: string }>).map(
        ({ id }) => id,
      );
      if (ids.length === 0) return 0;
      const updatedAt = this.now();
      this.db
        .prepare("UPDATE jobs SET status = 'queued', error = NULL, updated_at = ? WHERE status = 'running'")
        .run(updatedAt);
      for (const id of ids) {
        this.insertEvent(id, "warning", "Interrupted job recovered and queued", undefined, updatedAt);
      }
      return ids.length;
    });
    return recover();
  }

  claimNext(): JobRecord | null {
    const claim = this.db.transaction(() => {
      const runningStoryboardIds = new Set(
        this.list("running")
          .filter((job) => job.type === "image.generate" || job.type === "video.generate")
          .map(storyboardIdFromJob)
          .filter((value): value is number => value !== null),
      );
      const row = (this.db
        .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority DESC, created_at, rowid")
        .all() as JobRow[])
        .find((candidate) => {
          if (candidate.type !== "image.generate" && candidate.type !== "video.generate") return true;
          const storyboardId = storyboardIdFromJob(mapJob(candidate));
          return storyboardId === null || !runningStoryboardIds.has(storyboardId);
        });
      if (!row) return null;
      const updatedAt = this.now();
      const result = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'running', attempts = attempts + 1, error = NULL, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(updatedAt, row.id);
      if (result.changes !== 1) return null;
      this.insertEvent(row.id, "info", "Job started", undefined, updatedAt);
      return this.require(row.id);
    });
    return claim();
  }

  updateProgress(id: string, progress: number, message?: string, detail?: unknown): JobRecord {
    const value = assertProgress(progress);
    const updatedAt = this.now();
    const update = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE jobs SET progress = MAX(progress, ?), updated_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(value, updatedAt, id);
      if (result.changes !== 1) throw new Error(`Cannot update progress for a job that is not running: ${id}`);
      if (message) this.insertEvent(id, "info", message, detail ?? { progress: value }, updatedAt);
    });
    update();
    return this.require(id);
  }

  complete(id: string, output: unknown, persist?: () => void): JobRecord {
    const updatedAt = this.now();
    const complete = this.db.transaction(() => {
      const current = this.db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as
        | { status: JobStatus }
        | undefined;
      if (!current) throw new Error(`Job not found: ${id}`);
      if (current.status !== "running") return false;
      persist?.();
      const result = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'done', progress = 100, output_json = ?, error = NULL, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(JSON.stringify(output ?? null), updatedAt, id);
      if (result.changes === 1) this.insertEvent(id, "info", "Job completed", undefined, updatedAt);
      return result.changes === 1;
    });
    if (!complete()) return this.require(id);
    return this.require(id);
  }

  fail(id: string, error: unknown): JobRecord {
    const message = errorMessage(error);
    const updatedAt = this.now();
    const fail = this.db.transaction(() => {
      const result = this.db
        .prepare("UPDATE jobs SET status = 'error', error = ?, updated_at = ? WHERE id = ? AND status = 'running'")
        .run(message, updatedAt, id);
      if (result.changes === 1) this.insertEvent(id, "error", "Job failed", { error: message }, updatedAt);
      return result.changes === 1;
    });
    fail();
    return this.require(id);
  }

  pauseForAttention(id: string, error: PauseJobError): JobRecord {
    const updatedAt = this.now();
    const pause = this.db.transaction(() => {
      const result = this.db
        .prepare("UPDATE jobs SET status = 'paused', error = ?, updated_at = ? WHERE id = ? AND status = 'running'")
        .run(error.message, updatedAt, id);
      if (result.changes === 1) {
        const detail = error.detail && typeof error.detail === "object"
          ? { ...error.detail, error: error.message }
          : { error: error.message, detail: error.detail ?? null };
        this.insertEvent(id, "warning", "Job paused for attention", detail, updatedAt);
      }
      return result.changes === 1;
    });
    pause();
    return this.require(id);
  }

  pause(id: string): JobRecord {
    return this.transition(id, ["queued", "running"], "paused", "Job paused");
  }

  resume(id: string): JobRecord {
    return this.transition(id, ["paused"], "queued", "Job resumed");
  }

  cancel(id: string): JobRecord {
    const current = this.require(id);
    if (current.status === "cancelled") return current;
    return this.transition(id, ["queued", "running", "paused"], "cancelled", "Job cancelled");
  }

  retry(id: string): JobRecord {
    const updatedAt = this.now();
    const retry = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'queued', progress = 0, output_json = NULL, error = NULL, updated_at = ?
           WHERE id = ? AND status = 'error'`,
        )
        .run(updatedAt, id);
      if (result.changes !== 1) throw new Error(`Only failed jobs can be retried: ${id}`);
      this.insertEvent(id, "info", "Job queued for retry", undefined, updatedAt);
    });
    retry();
    return this.require(id);
  }

  interrupt(id: string): JobRecord {
    return this.transition(id, ["running"], "queued", "Job interrupted and queued", "warning");
  }

  private transition(
    id: string,
    from: JobStatus[],
    to: JobStatus,
    message: string,
    level: JobEventLevel = "info",
  ): JobRecord {
    const updatedAt = this.now();
    const placeholders = from.map(() => "?").join(", ");
    const transition = this.db.transaction(() => {
      const result = this.db
        .prepare(`UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`)
        .run(to, updatedAt, id, ...from);
      if (result.changes !== 1) {
        const current = this.require(id);
        throw new Error(`Cannot transition job ${id} from ${current.status} to ${to}`);
      }
      this.insertEvent(id, level, message, { status: to }, updatedAt);
    });
    transition();
    return this.require(id);
  }

  private insertEvent(
    jobId: string,
    level: JobEventLevel,
    message: string,
    detail: unknown,
    createdAt: string,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO job_events(job_id, level, message, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(jobId, level, message, detail === undefined ? null : JSON.stringify(detail), createdAt);
    return Number(result.lastInsertRowid);
  }
}

export type JobExecutionContext = {
  readonly jobId: string;
  readonly signal: AbortSignal;
  updateProgress(progress: number, message?: string, detail?: unknown): void;
  emit(level: JobEventLevel, message: string, detail?: unknown): void;
  complete(output: unknown, persist?: () => void): void;
};

export type JobHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: JobExecutionContext,
) => Promise<TOutput> | TOutput;

type ActiveJob = {
  controller: AbortController;
  promise: Promise<void>;
};

export class PersistentJobQueue {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly active = new Map<string, ActiveJob>();
  private started = false;
  private pumpScheduled = false;

  constructor(
    readonly store: JobStore,
    private readonly concurrency = 1,
    private readonly onTerminal?: (job: JobRecord) => void | Promise<void>,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError("Job queue concurrency must be a positive integer");
    }
  }

  register<TInput, TOutput>(type: string, handler: JobHandler<TInput, TOutput>): this {
    if (!type.trim()) throw new Error("Job type is required");
    this.handlers.set(type, handler as JobHandler);
    this.schedulePump();
    return this;
  }

  start(): number {
    if (this.started) return 0;
    const recovered = this.store.recoverInterrupted();
    this.started = true;
    this.schedulePump();
    return recovered;
  }

  enqueue<TInput>(type: string, input: TInput, id?: string): JobRecord<TInput> {
    if (
      id === undefined
      && (type === "image.generate" || type === "video.generate")
      && input !== null
      && typeof input === "object"
      && Number.isInteger((input as { storyboardId?: unknown }).storyboardId)
      && Number((input as { storyboardId?: unknown }).storyboardId) > 0
    ) {
      return this.enqueueUniqueStoryboard(type, input as TInput & { storyboardId: number });
    }
    const job = this.store.enqueue(type, input, id);
    this.schedulePump();
    return job;
  }

  enqueueUniqueStoryboard<TInput extends { storyboardId: number }>(
    type: StoryboardJobType,
    input: TInput,
  ): JobRecord<TInput> {
    const existing = this.store.findBlockingStoryboardJob(type, input.storyboardId);
    if (existing) return existing as JobRecord<TInput>;
    const job = this.store.enqueue(type, input);
    this.schedulePump();
    return job;
  }

  enqueuePriorityStoryboard<TInput extends { storyboardId: number }>(
    type: StoryboardJobType,
    input: TInput,
    priority = 100,
  ): JobRecord<TInput> {
    const queued = this.store.findQueuedStoryboardJob(type, input.storyboardId);
    if (queued) {
      const promoted = this.store.promote(queued.id, priority);
      this.schedulePump();
      return promoted as JobRecord<TInput>;
    }
    const job = this.store.enqueue(type, input, undefined, priority);
    this.schedulePump();
    return job;
  }

  pause(id: string): JobRecord {
    const job = this.store.pause(id);
    this.active.get(id)?.controller.abort(new Error("Job paused"));
    return job;
  }

  resume(id: string): JobRecord {
    const job = this.store.resume(id);
    this.schedulePump();
    return job;
  }

  cancel(id: string): JobRecord {
    const job = this.store.cancel(id);
    this.active.get(id)?.controller.abort(new Error("Job cancelled"));
    return job;
  }

  retry(id: string): JobRecord {
    const job = this.store.retry(id);
    this.schedulePump();
    return job;
  }

  async shutdown(): Promise<void> {
    this.started = false;
    const pending = [...this.active.entries()].map(([id, active]) => {
      if (this.store.get(id)?.status === "running") this.store.interrupt(id);
      active.controller.abort(new Error("Job queue is shutting down"));
      return active.promise;
    });
    await Promise.allSettled(pending);
  }

  async waitForIdle(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 || (this.started && this.store.list("queued").length > 0)) {
      if (Date.now() >= deadline) {
        const activeIds = [...this.active.keys()].join(", ") || "none";
        const queuedIds = this.store.list("queued").map(({ id }) => id).join(", ") || "none";
        throw new Error(
          `Job queue did not become idle within ${timeoutMs}ms (active: ${activeIds}; queued: ${queuedIds})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async waitForJobIdle(id: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.active.has(id)) {
      if (Date.now() >= deadline) throw new Error(`Job ${id} did not stop within ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private schedulePump(): void {
    if (!this.started || this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.started && this.active.size < this.concurrency) {
      const job = this.store.claimNext();
      if (!job) break;
      const controller = new AbortController();
      // Register the active entry before a synchronous handler can complete or throw.
      const promise = Promise.resolve().then(() => this.execute(job, controller));
      this.active.set(job.id, { controller, promise });
    }
  }

  private async execute(job: JobRecord, controller: AbortController): Promise<void> {
    try {
      const handler = this.handlers.get(job.type);
      if (!handler) throw new Error(`No handler registered for job type: ${job.type}`);
      const context: JobExecutionContext = {
        jobId: job.id,
        signal: controller.signal,
        updateProgress: (progress, message, detail) => {
          if (controller.signal.aborted) throw controller.signal.reason;
          this.store.updateProgress(job.id, progress, message, detail);
        },
        emit: (level, message, detail) => this.store.appendEvent(job.id, level, message, detail),
        complete: (output, persist) => {
          if (controller.signal.aborted) throw controller.signal.reason;
          this.store.complete(job.id, output, persist);
        },
      };
      const output = await handler(job.input, context);
      if (this.store.get(job.id)?.status === "running") this.store.complete(job.id, output);
    } catch (error) {
      if (this.store.get(job.id)?.status === "running") {
        if (error instanceof PauseJobError) this.store.pauseForAttention(job.id, error);
        else this.store.fail(job.id, error);
      }
    } finally {
      const terminal = this.store.get(job.id);
      if (terminal && (terminal.status === "done" || terminal.status === "error")) {
        Promise.resolve(this.onTerminal?.(terminal)).catch(() => undefined);
      }
      this.active.delete(job.id);
      this.schedulePump();
    }
  }
}
