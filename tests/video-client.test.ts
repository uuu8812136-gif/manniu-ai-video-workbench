import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncVideoTaskClient, VideoApiError } from "../src/main/video-client";

const MP4_BYTES = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom", "ascii"),
  Buffer.alloc(2_036, 1),
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("generic asynchronous video client", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ai-tool-video-client-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("submits, polls, downloads, and atomically names a completed video", async () => {
    let polls = 0;
    const progress: Array<number | null> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/videos/generations")) {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-key");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "owned-video-model",
          prompt: "A train enters the station",
          duration: 6,
          aspect_ratio: "16:9",
          seed: 42,
        });
        return json({ data: { task_id: "task-owned-1" } });
      }
      if (url.endsWith("/videos/task-owned-1")) {
        polls += 1;
        return polls === 1
          ? json({ status: "processing", progress: 0.5 })
          : json({ status: "completed", output: { url: "https://files.example/result/clip.mp4" } });
      }
      if (url === "https://files.example/result/clip.mp4") {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return new Response(MP4_BYTES, {
          headers: { "content-type": "video/mp4", "content-length": String(MP4_BYTES.length) },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    const client = new AsyncVideoTaskClient({
      baseUrl: "http://127.0.0.1:8123/v1",
      apiKey: "private-key",
      pollIntervalMs: 1,
      fetch: fetcher,
    });

    const submitted = await client.submit({
      model: "owned-video-model",
      prompt: "A train enters the station",
      durationSeconds: 6,
      aspectRatio: "16:9",
      parameters: { model: "cannot-override", prompt: "cannot-override", seed: 42 },
    });
    const completed = await client.waitForResult(submitted.taskId, {
      pollIntervalMs: 1,
      timeoutMs: 1_000,
      onProgress: (status) => progress.push(status.progress),
    });
    const downloaded = await client.downloadResult(completed.resultUrl, {
      outputDirectory: directory,
      stem: "scene:01",
      fileName: "scene:01.mp4",
      timeoutMs: 1_000,
      maxBytes: 4_096,
    });

    expect(submitted.taskId).toBe("task-owned-1");
    expect(progress).toEqual([50, null]);
    expect(downloaded).toMatchObject({ bytes: MP4_BYTES.length, mimeType: "video/mp4" });
    expect(downloaded.path).toMatch(/scene-01\.mp4$/);
    expect(await readFile(downloaded.path)).toEqual(MP4_BYTES);
    expect((await readdir(directory)).some((name) => name.endsWith(".part"))).toBe(false);
  });

  it("supports POST polling and common nested response fields", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ task_id: "nested-task" });
      return json({ data: { state: "success", result: { url: "/downloads/nested.webm" }, progress: "100" } });
    }) as typeof fetch;
    const client = new AsyncVideoTaskClient({
      baseUrl: "https://video.example/api",
      statusPath: "tasks/status",
      pollMethod: "POST",
      fetch: fetcher,
    });

    await expect(client.poll("nested-task")).resolves.toMatchObject({
      phase: "succeeded",
      progress: 100,
      resultUrl: "/downloads/nested.webm",
    });
  });

  it("enforces timeout and caller cancellation even when transport ignores AbortSignal", async () => {
    const never = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const client = new AsyncVideoTaskClient({
      baseUrl: "https://video.example/v1",
      requestTimeoutMs: 20,
      fetch: never,
    });

    const timeout = await client.submit({ model: "m", prompt: "p" }).catch((reason: unknown) => reason);
    expect(timeout).toBeInstanceOf(VideoApiError);
    expect(timeout).toMatchObject({ kind: "timeout" });

    const controller = new AbortController();
    const polling = client.poll("task-cancel", { signal: controller.signal, timeoutMs: 1_000 });
    controller.abort(new Error("user cancelled"));
    const cancelled = await polling.catch((reason: unknown) => reason);
    expect(cancelled).toBeInstanceOf(VideoApiError);
    expect(cancelled).toMatchObject({ kind: "cancelled" });

    const downloadController = new AbortController();
    const download = client.downloadResult("https://files.example/pending.mp4", {
      outputDirectory: directory,
      stem: "cancelled-download",
      signal: downloadController.signal,
      timeoutMs: 1_000,
    });
    downloadController.abort(new Error("user cancelled download"));
    const downloadError = await download.catch((reason: unknown) => reason);
    expect(downloadError).toBeInstanceOf(VideoApiError);
    expect(downloadError).toMatchObject({ kind: "cancelled" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("removes partial files when download validation fails", async () => {
    const client = new AsyncVideoTaskClient({
      baseUrl: "https://video.example/v1",
      fetch: (async () =>
        new Response(MP4_BYTES, {
          headers: { "content-type": "video/mp4", "content-length": String(MP4_BYTES.length) },
        })) as typeof fetch,
    });

    const error = await client.downloadResult("https://files.example/too-big.mp4", {
      outputDirectory: directory,
      stem: "oversize",
      maxBytes: 8,
      timeoutMs: 1_000,
      retryDelayMs: 1,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(VideoApiError);
    expect(error).toMatchObject({ kind: "download" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("retries an incomplete download and verifies Content-Length before publishing", async () => {
    let attempts = 0;
    const client = new AsyncVideoTaskClient({
      baseUrl: "https://video.example/v1",
      fetch: vi.fn(async () => {
        attempts += 1;
        return new Response(MP4_BYTES, {
          headers: {
            "content-type": "video/mp4",
            "content-length": String(MP4_BYTES.length + (attempts === 1 ? 1 : 0)),
          },
        });
      }) as typeof fetch,
    });

    const result = await client.downloadResult("https://files.example/retry.mp4", {
      outputDirectory: directory,
      stem: "retry-incomplete",
      timeoutMs: 1_000,
      maxBytes: 4_096,
      retryDelayMs: 1,
    });

    expect(attempts).toBe(2);
    expect(await readFile(result.path)).toEqual(MP4_BYTES);
    expect((await readdir(directory)).some((name) => name.endsWith(".part"))).toBe(false);
  });

  it("rejects videos smaller than 1024 bytes after three attempts", async () => {
    const fetcher = vi.fn(async () => new Response(Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypisom", "ascii"),
      Buffer.alloc(32, 1),
    ]), { headers: { "content-type": "video/mp4" } }));
    const client = new AsyncVideoTaskClient({
      baseUrl: "https://video.example/v1",
      fetch: fetcher as typeof fetch,
    });

    await expect(client.downloadResult("https://files.example/tiny.mp4", {
      outputDirectory: directory,
      stem: "tiny",
      timeoutMs: 1_000,
      retryDelayMs: 1,
    })).rejects.toMatchObject({ kind: "download", message: expect.stringContaining("too small") });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects an explicit non-video MIME even when the URL ends in mp4", async () => {
    const client = new AsyncVideoTaskClient({
      baseUrl: "https://video.example/v1",
      fetch: (async () =>
        new Response(MP4_BYTES, {
          headers: { "content-type": "text/html; charset=utf-8" },
        })) as typeof fetch,
    });

    const error = await client.downloadResult("https://files.example/login.mp4", {
      outputDirectory: directory,
      stem: "html-response",
      timeoutMs: 1_000,
      retryDelayMs: 1,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(VideoApiError);
    expect(error).toMatchObject({ kind: "download" });
    expect(String(error)).toContain("non-video content type");
    expect(await readdir(directory)).toEqual([]);
  });

  it("requires video magic bytes for generic binary downloads", async () => {
    const client = new AsyncVideoTaskClient({
      baseUrl: "https://video.example/v1",
      fetch: (async () => new Response(Buffer.from("<html>login</html>"), {
        headers: { "content-type": "application/octet-stream" },
      })) as typeof fetch,
    });

    const error = await client.downloadResult("https://files.example/login.mp4", {
      outputDirectory: directory,
      stem: "binary-html-response",
      timeoutMs: 1_000,
      retryDelayMs: 1,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(VideoApiError);
    expect(error).toMatchObject({ kind: "download" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("reports provider failure without leaking the configured API key", async () => {
    const client = new AsyncVideoTaskClient({
      baseUrl: "https://video.example/v1",
      apiKey: "must-not-leak",
      pollIntervalMs: 1,
      fetch: (async () => json({ status: "failed", error: { message: "render rejected" } })) as typeof fetch,
    });

    const error = await client.waitForResult("failed-task", { timeoutMs: 1_000 }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(VideoApiError);
    expect(error).toMatchObject({ kind: "provider_failed", message: "render rejected" });
    expect(String(error)).not.toContain("must-not-leak");
  });
});
