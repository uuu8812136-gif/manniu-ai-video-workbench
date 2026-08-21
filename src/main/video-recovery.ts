import { randomUUID } from "node:crypto";
import type { PersistentJobQueue } from "./jobs";
import type { StoryboardRepository } from "./repositories";

export function enqueuePersistedViduRecoveries(
  queue: PersistentJobQueue,
  storyboards: StoryboardRepository,
  options: { now?: number; retryCooldownMs?: number; minimumAgeMs?: number; leaseMs?: number } = {},
): number {
  const now = options.now ?? Date.now();
  const minimumAgeMs = options.minimumAgeMs ?? 45_000;
  const leaseMs = options.leaseMs ?? 21 * 60_000;
  const leaseOwner = `recovery:${process.pid}:${randomUUID()}`;
  let enqueued = 0;
  for (const storyboard of storyboards.listRecoverableViduTasks(now, options.retryCooldownMs !== undefined)) {
    if (queue.store.findBlockingStoryboardJob("video.generate", storyboard.id)) continue;
    if (!storyboards.claimViduRecoveryLease(
      storyboard.id,
      storyboard.videoTaskId!,
      leaseOwner,
      now,
      leaseMs,
      options.retryCooldownMs !== undefined,
      minimumAgeMs,
      options.retryCooldownMs,
    )) continue;
    try {
      queue.enqueueUniqueStoryboard("video.generate", {
        storyboardId: storyboard.id,
        provider: "vidu-browser" as const,
      });
      enqueued += 1;
    } catch (error) {
      storyboards.releaseViduRecoveryLease(storyboard.id, storyboard.videoTaskId!, leaseOwner);
      throw error;
    }
  }
  return enqueued;
}

export class ViduRecoveryWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;

  constructor(
    private readonly queue: PersistentJobQueue,
    private readonly storyboards: StoryboardRepository,
    private readonly options: { scanIntervalMs?: number; retryCooldownMs?: number; minimumAgeMs?: number; leaseMs?: number } = {},
  ) {}

  start(): number {
    if (this.timer) return 0;
    const enqueued = this.scan();
    this.timer = setInterval(() => this.scan(), this.options.scanIntervalMs ?? 5_000);
    this.timer.unref?.();
    return enqueued;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  scan(): number {
    if (this.scanning) return 0;
    this.scanning = true;
    try {
      return enqueuePersistedViduRecoveries(this.queue, this.storyboards, {
        retryCooldownMs: this.options.retryCooldownMs,
        minimumAgeMs: this.options.minimumAgeMs,
        leaseMs: this.options.leaseMs,
      });
    } finally {
      this.scanning = false;
    }
  }
}
