import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../src/main/database";
import { JobStore, PersistentJobQueue } from "../src/main/jobs";
import { ProjectRepository, SettingsRepository, StoryboardRepository } from "../src/main/repositories";
import { registerVideoWorkflowHandler } from "../src/main/video-workflow";

const MP4_BYTES = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom", "ascii"),
  Buffer.alloc(2_036, 2),
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("video generation job workflow", () => {
  let root: string;
  let database: AppDatabase;
  let queue: PersistentJobQueue;
  let projects: ProjectRepository;
  let storyboards: StoryboardRepository;
  let settings: SettingsRepository;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ai-tool-video-workflow-中文-"));
    database = new AppDatabase(":memory:");
    projects = new ProjectRepository(database.connection);
    storyboards = new StoryboardRepository(database.connection);
    settings = new SettingsRepository(database.connection);
    settings.set("video_api_base_url", "http://127.0.0.1:9123/v1");
    settings.set("video_api_key", "owned-api-key");
    settings.set("video_model", "owned-video-model");
    settings.set("video_poll_interval_ms", "250");
    settings.set("video_timeout_ms", "5000");
    queue = new PersistentJobQueue(new JobStore(database.connection), 1);
    registerVideoWorkflowHandler(queue, { settings, storyboards, projects, projectsRoot: root });
    queue.start();
  });

  afterEach(async () => {
    await queue.shutdown();
    database.close();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  function createStoryboard(name = "Video project") {
    const project = projects.create({ name });
    return storyboards.replace(project.id, [
      { index: 0, originalText: "Train arrives", prompt: "A train arrives at night", duration: 6 },
    ])[0];
  }

  it("submits, polls, atomically downloads, and attaches a video", async () => {
    const storyboard = createStoryboard("Owned API project");
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/videos/generations")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owned-api-key");
        return json({ task_id: "provider-task-1" });
      }
      if (url.endsWith("/videos/provider-task-1")) {
        return json({ status: "completed", progress: 100, video_url: "https://files.example/generated.mp4" });
      }
      if (url === "https://files.example/generated.mp4") {
        return new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    const completed = queue.store.require(job.id);
    const updated = storyboards.get(storyboard.id);
    expect(completed).toMatchObject({
      status: "done",
      output: {
        storyboardId: storyboard.id,
        providerTaskId: "provider-task-1",
        model: "owned-video-model",
        bytes: MP4_BYTES.length,
      },
    });
    expect(updated).toMatchObject({
      status: "done",
      taskId: null,
      videoTaskId: null,
      submitCount: 1,
    });
    expect(updated.videoPath).toContain(join(`project-${updated.projectId}`, "videos"));
    expect(existsSync(updated.videoPath!)).toBe(true);
    expect((await readdir(join(root, `project-${updated.projectId}`, "videos"))).some((name) => name.endsWith(".part"))).toBe(false);
  });

  it("resumes a persisted provider task without submitting a duplicate", async () => {
    const storyboard = createStoryboard("Resume project");
    storyboards.saveVideoProviderTask(storyboard.id, "provider-existing");
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        const url = String(input);
        if (url.endsWith("/videos/provider-existing")) {
          return json({ status: "done", url: "https://files.example/resumed.mp4" });
        }
        if (url === "https://files.example/resumed.mp4") {
          return new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({ status: "done", output: { providerTaskId: "provider-existing" } });
    expect(methods).not.toContain("POST");
    expect(storyboards.get(storyboard.id)).toMatchObject({
      status: "done",
      taskId: null,
      videoTaskId: null,
    });
  });

  it("preserves a submitted provider task across shutdown and resumes it without another submit", async () => {
    const storyboard = createStoryboard("Interrupted resume project");
    let submitCount = 0;
    let allowCompletion = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/videos/generations")) {
          submitCount += 1;
          return json({ task_id: "provider-interrupted" });
        }
        if (url.endsWith("/videos/provider-interrupted")) {
          return allowCompletion
            ? json({ status: "completed", video_url: "https://files.example/interrupted.mp4" })
            : json({ status: "processing", progress: 20 });
        }
        if (url === "https://files.example/interrupted.mp4") {
          return new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await waitUntil(() => storyboards.get(storyboard.id).videoTaskId === "provider-interrupted");
    await queue.shutdown();

    expect(queue.store.require(job.id).status).toBe("queued");
    expect(storyboards.get(storyboard.id)).toMatchObject({
      status: "pending",
      taskId: null,
      videoTaskId: "provider-interrupted",
    });

    allowCompletion = true;
    queue = new PersistentJobQueue(new JobStore(database.connection), 1);
    registerVideoWorkflowHandler(queue, { settings, storyboards, projects, projectsRoot: root });
    queue.start();
    await queue.waitForIdle();

    expect(submitCount).toBe(1);
    expect(queue.store.require(job.id)).toMatchObject({
      status: "done",
      output: { providerTaskId: "provider-interrupted" },
    });
    expect(storyboards.get(storyboard.id)).toMatchObject({
      status: "done",
      taskId: null,
      videoTaskId: null,
    });
  });

  it("switches to a backup API key after a retryable authentication failure", async () => {
    const storyboard = createStoryboard("Key failover project");
    settings.set("video_api_key", "rejected-key");
    settings.set("video_api_keys", "working-key");
    settings.set("video_concurrency_per_key", "1");
    const submitKeys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/videos/generations")) {
          const authorization = new Headers(init?.headers).get("authorization") ?? "";
          submitKeys.push(authorization);
          if (authorization === "Bearer rejected-key") return json({ error: "rejected" }, 401);
          return json({ task_id: "provider-failover" });
        }
        if (url.endsWith("/videos/provider-failover")) {
          return json({ status: "completed", video_url: "https://files.example/failover.mp4" });
        }
        if (url === "https://files.example/failover.mp4") {
          return new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id).status).toBe("done");
    expect(submitKeys).toEqual(["Bearer rejected-key", "Bearer working-key"]);
    const warnings = queue.store.events(job.id).filter(({ level }) => level === "warning");
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "当前视频 API Key 请求失败，正在切换下一个 Key",
        detail: expect.objectContaining({ kind: "authentication", status: 401 }),
      }),
    ]));
    expect(JSON.stringify(warnings)).not.toContain("rejected-key");
    expect(JSON.stringify(warnings)).not.toContain("working-key");
  });

  it("enforces video_concurrency_per_key across concurrent jobs", async () => {
    await queue.shutdown();
    queue = new PersistentJobQueue(new JobStore(database.connection), 2);
    registerVideoWorkflowHandler(queue, { settings, storyboards, projects, projectsRoot: root });
    settings.set("video_concurrency_per_key", "1");
    queue.start();
    const firstStoryboard = createStoryboard("Concurrent video one");
    const secondStoryboard = createStoryboard("Concurrent video two");
    let submitCount = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/videos/generations")) {
          submitCount += 1;
          const current = submitCount;
          if (current === 1) await firstGate;
          return json({ task_id: `provider-concurrent-${current}` });
        }
        const statusMatch = url.match(/\/videos\/(provider-concurrent-\d+)$/);
        if (statusMatch) {
          return json({ status: "completed", video_url: `https://files.example/${statusMatch[1]}.mp4` });
        }
        if (url.startsWith("https://files.example/provider-concurrent-")) {
          return new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );

    const first = queue.enqueue("video.generate", { storyboardId: firstStoryboard.id });
    const second = queue.enqueue("video.generate", { storyboardId: secondStoryboard.id });
    await waitUntil(() => submitCount === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(submitCount).toBe(1);
    releaseFirst();
    await queue.waitForIdle();

    expect(submitCount).toBe(2);
    expect(queue.store.require(first.id).status).toBe("done");
    expect(queue.store.require(second.id).status).toBe("done");
  });

  it("marks provider failures without creating a video file", async () => {
    const storyboard = createStoryboard("Failure project");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/videos/generations")
          ? json({ id: "provider-failed" })
          : json({ status: "failed", error: { message: "generation rejected" } }),
      ),
    );

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({ status: "error", error: "generation rejected" });
    expect(storyboards.get(storyboard.id)).toMatchObject({
      status: "pending",
      taskId: null,
      videoTaskId: null,
      videoPath: null,
    });
  });

  it("cancels polling promptly and leaves no partial output", async () => {
    const storyboard = createStoryboard("Cancel project");
    let polls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/videos/generations")) return json({ task_id: "provider-cancel" });
        polls += 1;
        return json({ status: "processing", progress: 10 });
      }),
    );

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await waitUntil(() => polls > 0);
    queue.cancel(job.id);
    await queue.waitForIdle(1_000);

    expect(queue.store.require(job.id).status).toBe("cancelled");
    expect(storyboards.get(storyboard.id)).toMatchObject({
      status: "pending",
      taskId: null,
      videoTaskId: null,
      videoPath: null,
    });
    const outputDirectory = join(root, `project-${storyboard.projectId}`, "videos");
    expect(existsSync(outputDirectory)).toBe(false);
  });
});
