/// <reference path="../src/renderer/src/env.d.ts" />

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Storyboard, WorkflowJob } from "../src/shared/contracts";
import { restoreBatchQueueSnapshot } from "../src/renderer/src/pages/batch-queue-state";

describe("batch queue controller", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("persists drag reordering through the existing queue snapshot storage", async () => {
    const values = new Map<string, string>();
    const localStorage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key); },
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    vi.stubGlobal("window", { localStorage });

    const { batchQueueController, batchQueueStorageKey } = await import("../src/renderer/src/pages/batch-queue-controller");
    const projects = [1, 2, 3].map((id) => ({ id, name: `项目 ${id}` }) as Project);
    batchQueueController.addProjects(projects);
    const [first, , third] = batchQueueController.getSnapshot().entries;

    batchQueueController.reorder(first!.id, third!.id);

    const persisted = values.get(batchQueueStorageKey()) ?? null;
    expect(batchQueueController.getSnapshot().entries.map(({ projectId }) => projectId)).toEqual([2, 3, 1]);
    expect(restoreBatchQueueSnapshot(persisted).entries.map(({ projectId }) => projectId)).toEqual([2, 3, 1]);
  });

  it("reschedules a timed start by 60 seconds when another global job is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    const values = new Map<string, string>();
    const localStorage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key); },
      setItem: (key: string, value: string) => { values.set(key, value); },
    } as Storage;
    const list = vi.fn().mockResolvedValue([{ id: "busy", type: "video.generate", status: "running" }]);
    const alert = vi.fn();
    vi.stubGlobal("window", {
      localStorage,
      offline: { jobs: { list } },
      alert,
      setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
    });

    const { batchQueueController } = await import("../src/renderer/src/pages/batch-queue-controller");
    batchQueueController.addProjects([{ id: 1, name: "项目 1" } as Project]);
    batchQueueController.schedule(Date.now() + 1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(list).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    expect(batchQueueController.getSnapshot()).toMatchObject({
      running: false,
      scheduledAt: Date.now() + 60_000,
    });
  });

  it("does not complete a project until every submitted video is downloaded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    const values = new Map<string, string>();
    const localStorage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key); },
      setItem: (key: string, value: string) => { values.set(key, value); },
    } as Storage;
    const storyboards = new Map<number, Storyboard[]>([
      [1, [{ id: 101, projectId: 1, index: 0, prompt: "项目一画面", videoPath: null, videoTaskId: null, videoSubmissionState: "idle" } as Storyboard]],
      [2, [{ id: 201, projectId: 2, index: 0, prompt: "项目二画面", videoPath: null, videoTaskId: null, videoSubmissionState: "idle" } as Storyboard]],
    ]);
    const jobs: WorkflowJob[] = [];
    const enqueue = vi.fn(async (_type: string, input: { storyboardId: number }) => {
      const projectId = input.storyboardId === 101 ? 1 : 2;
      const current = storyboards.get(projectId)![0]!;
      storyboards.set(projectId, [{ ...current, videoTaskId: `vidu-${input.storyboardId}`, videoSubmissionState: "submitted" }]);
      const job = {
        id: `job-${input.storyboardId}`,
        type: "video.generate",
        status: "running",
        progress: 12,
        input,
      } as WorkflowJob;
      jobs.push(job);
      globalThis.setTimeout(() => {
        const submitted = storyboards.get(projectId)![0]!;
        storyboards.set(projectId, [{ ...submitted, videoPath: `D:\\${input.storyboardId}.mp4`, status: "done" }]);
        job.status = "done";
        job.progress = 100;
      }, 1_500);
      return job;
    });
    vi.stubGlobal("window", {
      localStorage,
      offline: {
        storyboards: { list: vi.fn(async (projectId: number) => storyboards.get(projectId) ?? []) },
        jobs: { list: vi.fn(async () => jobs), enqueue },
        notifications: { notify: vi.fn(async () => true) },
      },
      alert: vi.fn(),
      setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
    });

    const { batchQueueController } = await import("../src/renderer/src/pages/batch-queue-controller");
    batchQueueController.addProjects([
      { id: 1, name: "项目 1" } as Project,
      { id: 2, name: "项目 2" } as Project,
    ]);
    await batchQueueController.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(batchQueueController.getSnapshot()).toMatchObject({
      running: true,
      currentProjectId: 1,
      entries: [{ projectId: 1, status: "running" }, { projectId: 2, status: "waiting" }],
    });

    await vi.advanceTimersByTimeAsync(3_500);

    expect(enqueue.mock.calls.map((call) => call[1].storyboardId)).toEqual([101, 201]);
    expect(batchQueueController.getSnapshot()).toMatchObject({
      running: false,
      currentProjectId: null,
      entries: [{ projectId: 1, status: "done" }, { projectId: 2, status: "done" }],
    });
    expect(jobs.every((job) => job.status === "done" && job.progress === 100)).toBe(true);
    expect([...storyboards.values()].flat().every((storyboard) => Boolean(storyboard.videoPath))).toBe(true);
  });

  it("cancels and skips a project after 20 minutes without submission or job progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    const values = new Map<string, string>();
    const localStorage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key); },
      setItem: (key: string, value: string) => { values.set(key, value); },
    } as Storage;
    const storyboards = new Map<number, Storyboard[]>([
      [1, [{ id: 101, projectId: 1, index: 0, prompt: "卡住的画面", videoPath: null, videoTaskId: null, videoSubmissionState: "submitting" } as Storyboard]],
      [2, [{ id: 201, projectId: 2, index: 0, prompt: "已完成画面", videoPath: "D:\\201.mp4", videoTaskId: "vidu-201", videoSubmissionState: "submitted" } as Storyboard]],
    ]);
    const jobs: WorkflowJob[] = [];
    const enqueue = vi.fn(async (_type: string, input: { storyboardId: number }) => {
      const job = {
        id: `job-${input.storyboardId}`,
        type: "video.generate",
        status: "running",
        progress: 4,
        input,
      } as WorkflowJob;
      jobs.push(job);
      return job;
    });
    const cancel = vi.fn(async (jobId: string) => {
      const job = jobs.find((candidate) => candidate.id === jobId)!;
      job.status = "cancelled";
      return job;
    });
    vi.stubGlobal("window", {
      localStorage,
      offline: {
        storyboards: { list: vi.fn(async (projectId: number) => storyboards.get(projectId) ?? []) },
        jobs: { list: vi.fn(async () => jobs), enqueue, cancel },
        notifications: { notify: vi.fn(async () => true) },
      },
      alert: vi.fn(),
      setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
    });

    const { batchQueueController } = await import("../src/renderer/src/pages/batch-queue-controller");
    batchQueueController.addProjects([
      { id: 1, name: "项目 1" } as Project,
      { id: 2, name: "项目 2" } as Project,
    ]);
    await batchQueueController.start();
    await vi.advanceTimersByTimeAsync(20 * 60_000 + 20_000);

    expect(cancel).toHaveBeenCalledWith("job-101");
    expect(batchQueueController.getSnapshot()).toMatchObject({
      running: false,
      currentProjectId: null,
      entries: [{ projectId: 1, status: "skipped" }, { projectId: 2, status: "done" }],
    });
  });

  it.each([
    ["stop", "waiting"],
    ["skipCurrent", "skipped"],
  ] as const)("preserves the requested %s state when cancellation completes during a poll", async (action, expectedStatus) => {
    vi.useFakeTimers();
    const values = new Map<string, string>();
    const localStorage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key); },
      setItem: (key: string, value: string) => { values.set(key, value); },
    } as Storage;
    const storyboard = { id: 101, projectId: 1, index: 0, prompt: "待生成", videoPath: null, videoTaskId: null, videoSubmissionState: "idle" } as Storyboard;
    const jobs: WorkflowJob[] = [];
    const enqueue = vi.fn(async (_type: string, input: { storyboardId: number }) => {
      const job = { id: "job-101", type: "video.generate", status: "running", progress: 10, input } as WorkflowJob;
      jobs.push(job);
      return job;
    });
    const cancel = vi.fn(async () => {
      jobs[0]!.status = "cancelled";
      return jobs[0]!;
    });
    vi.stubGlobal("window", {
      localStorage,
      offline: {
        storyboards: { list: vi.fn(async () => [storyboard]) },
        jobs: { list: vi.fn(async () => jobs), enqueue, cancel },
        notifications: { notify: vi.fn(async () => true) },
      },
      alert: vi.fn(),
      setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
    });

    const { batchQueueController } = await import("../src/renderer/src/pages/batch-queue-controller");
    batchQueueController.addProjects([{ id: 1, name: "项目 1" } as Project]);
    await batchQueueController.start();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    await batchQueueController[action]();
    await vi.advanceTimersByTimeAsync(1_100);

    expect(cancel).toHaveBeenCalledWith("job-101");
    expect(batchQueueController.getSnapshot()).toMatchObject({
      running: false,
      currentProjectId: null,
      entries: [{ projectId: 1, status: expectedStatus }],
    });
  });
});
