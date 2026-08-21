import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export type VideoApiErrorKind =
  | "configuration"
  | "timeout"
  | "cancelled"
  | "network"
  | "authentication"
  | "subject_limit"
  | "not_found"
  | "unavailable"
  | "rate_limit"
  | "server"
  | "http"
  | "invalid_response"
  | "provider_failed"
  | "download";

export class VideoApiError extends Error {
  constructor(
    readonly kind: VideoApiErrorKind,
    message: string,
    readonly status?: number,
    readonly requestId?: string,
    readonly responseBody?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VideoApiError";
  }
}

export type VideoTaskClientOptions = {
  baseUrl: string;
  apiKey?: string;
  apiKeyHeader?: string;
  submitPath?: string;
  statusPath?: string;
  pollMethod?: "GET" | "POST";
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  overallTimeoutMs?: number;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  sendAuthToResult?: boolean;
};

export type VideoSubmitRequest = {
  model: string;
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: string;
  imageUrl?: string;
  parameters?: Record<string, unknown>;
};

export type SubmittedVideoTask = {
  taskId: string;
  raw: unknown;
};

export type VideoTaskPhase = "pending" | "running" | "succeeded" | "failed";

export type VideoTaskStatus = {
  taskId: string;
  phase: VideoTaskPhase;
  providerStatus: string;
  progress: number | null;
  resultUrl: string | null;
  error: string | null;
  raw: unknown;
};

export type CompletedVideoTask = VideoTaskStatus & {
  phase: "succeeded";
  resultUrl: string;
};

export type DownloadedVideo = {
  path: string;
  bytes: number;
  mimeType: string | null;
};

export type VideoRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

type JsonObject = Record<string, unknown>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_VIDEO_BYTES = 1_024;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 2_000;
const MAX_JSON_BYTES = 5 * 1024 * 1024;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new VideoApiError("configuration", `${label} must be greater than zero`);
  }
  return value;
}

function buildEndpoint(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.trim();
  if (!trimmedBase) throw new VideoApiError("configuration", "Video API baseUrl is required");
  const trimmedPath = path.trim();
  if (!trimmedPath) throw new VideoApiError("configuration", "Video API endpoint path is required");
  try {
    const value = new URL(trimmedPath.replace(/^\/+/, ""), `${trimmedBase.replace(/\/+$/, "")}/`);
    if (value.protocol !== "http:" && value.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return value.toString();
  } catch (cause) {
    throw new VideoApiError("configuration", "Video API endpoint must use HTTP or HTTPS", undefined, undefined, undefined, {
      cause,
    });
  }
}

function combineAbort(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = (): void => controller.abort(signal?.reason ?? new Error("Request cancelled"));
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    },
  };
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

function errorKind(status: number): VideoApiErrorKind {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "http";
}

function providerMessage(body: unknown, fallback: string): string {
  if (!isObject(body)) return fallback;
  if (typeof body.message === "string" && body.message.trim()) return body.message;
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  if (isObject(body.error) && typeof body.error.message === "string" && body.error.message.trim()) {
    return body.error.message;
  }
  if (isObject(body.data)) return providerMessage(body.data, fallback);
  return fallback;
}

function nestedValue(body: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    let current: unknown = body;
    for (const key of path) {
      if (!isObject(current)) {
        current = undefined;
        break;
      }
      current = current[key];
    }
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}

function nestedString(body: unknown, paths: string[][]): string | null {
  const value = nestedValue(body, paths);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function taskIdFrom(body: unknown): string | null {
  return nestedString(body, [
    ["task_id"], ["taskId"], ["id"],
    ["data", "task_id"], ["data", "taskId"], ["data", "id"],
  ]);
}

function resultUrlFrom(body: unknown): string | null {
  const direct = nestedString(body, [
    ["result_url"], ["resultUrl"], ["video_url"], ["videoUrl"], ["url"],
    ["result", "url"], ["result", "video_url"], ["result", "videoUrl"],
    ["output", "url"], ["output", "video_url"], ["output", "videoUrl"],
    ["data", "result_url"], ["data", "resultUrl"], ["data", "video_url"], ["data", "videoUrl"],
    ["data", "url"], ["data", "result", "url"], ["data", "output", "url"],
  ]);
  if (direct) return direct;
  const outputs = nestedValue(body, [["outputs"], ["output"], ["data", "outputs"], ["data", "output"]]);
  if (!Array.isArray(outputs) || outputs.length === 0) return null;
  const first = outputs[0];
  return typeof first === "string"
    ? first
    : nestedString(first, [["url"], ["video_url"], ["videoUrl"], ["result_url"]]);
}

function normalizedProgress(body: unknown): number | null {
  const value = nestedValue(body, [
    ["progress"], ["percentage"], ["percent"],
    ["data", "progress"], ["data", "percentage"], ["data", "percent"],
  ]);
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number < 0) return null;
  const percent = number > 0 && number <= 1 ? number * 100 : number;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function normalizeStatus(value: string): VideoTaskPhase | null {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["queued", "pending", "submitted", "created", "waiting"].includes(normalized)) return "pending";
  if (["running", "processing", "in_progress", "generating"].includes(normalized)) return "running";
  if (["succeeded", "completed", "complete", "done", "success", "successful"].includes(normalized)) return "succeeded";
  if (["failed", "error", "cancelled", "canceled", "rejected"].includes(normalized)) return "failed";
  return null;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cancel = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Request cancelled"));
    };
    const cleanup = (): void => signal?.removeEventListener("abort", cancel);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function safeStem(value: string): string {
  const normalized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "");
  return (normalized || "video").slice(0, 80);
}

function extensionFromMime(value: string | null): string | null {
  const mime = value?.split(";", 1)[0].trim().toLowerCase();
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/webm") return "webm";
  if (mime === "video/quicktime") return "mov";
  if (mime === "video/x-matroska") return "mkv";
  if (mime === "video/x-m4v") return "m4v";
  if (mime === "video/mpeg") return "mpeg";
  return null;
}

function isExplicitNonVideoMime(value: string | null): boolean {
  const mime = value?.split(";", 1)[0].trim().toLowerCase();
  if (!mime || mime.startsWith("video/")) return false;
  return mime !== "application/octet-stream" && mime !== "binary/octet-stream";
}

function extensionFromBytes(bytes: Buffer): string | null {
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "webm";
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01) return "mpeg";
  return null;
}

export class AsyncVideoTaskClient {
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly overallTimeoutMs: number;
  private readonly submitPath: string;
  private readonly statusPath: string;

  constructor(private readonly options: VideoTaskClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (!this.fetcher) throw new VideoApiError("configuration", "No fetch implementation is available");
    this.requestTimeoutMs = positive(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
    this.pollIntervalMs = positive(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs");
    this.overallTimeoutMs = positive(options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS, "overallTimeoutMs");
    this.submitPath = options.submitPath?.trim() || "videos/generations";
    this.statusPath = options.statusPath?.trim() || "videos/{taskId}";
    buildEndpoint(options.baseUrl, this.submitPath);
  }

  async submit(request: VideoSubmitRequest, options?: VideoRequestOptions): Promise<SubmittedVideoTask> {
    if (!request.model.trim()) throw new VideoApiError("configuration", "Video model is required");
    if (!request.prompt.trim()) throw new VideoApiError("configuration", "Video prompt is required");
    const body = await this.requestJson("POST", this.submitPath, {
      ...request.parameters,
      model: request.model.trim(),
      prompt: request.prompt.trim(),
      ...(request.durationSeconds === undefined ? {} : { duration: request.durationSeconds }),
      ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
      ...(request.imageUrl ? { image_url: request.imageUrl } : {}),
    }, options);
    const taskId = taskIdFrom(body);
    if (!taskId) {
      throw new VideoApiError("invalid_response", "Video submit response does not contain a task id", undefined, undefined, body);
    }
    return { taskId, raw: body };
  }

  async poll(taskId: string, options?: VideoRequestOptions): Promise<VideoTaskStatus> {
    const id = taskId.trim();
    if (!id) throw new VideoApiError("configuration", "Video task id is required");
    const method = this.options.pollMethod ?? "GET";
    const encoded = encodeURIComponent(id);
    const hasPlaceholder = this.statusPath.includes("{taskId}");
    const path = hasPlaceholder
      ? this.statusPath.replaceAll("{taskId}", encoded)
      : method === "GET"
        ? `${this.statusPath.replace(/\/+$/, "")}/${encoded}`
        : this.statusPath;
    const body = await this.requestJson(method, path, method === "POST" ? { task_id: id } : undefined, options);
    const providerStatus = nestedString(body, [
      ["status"], ["state"], ["data", "status"], ["data", "state"],
    ]);
    if (!providerStatus) {
      throw new VideoApiError("invalid_response", "Video status response does not contain status", undefined, undefined, body);
    }
    const phase = normalizeStatus(providerStatus);
    if (!phase) {
      throw new VideoApiError("invalid_response", `Unknown video task status: ${providerStatus}`, undefined, undefined, body);
    }
    const status: VideoTaskStatus = {
      taskId: id,
      phase,
      providerStatus,
      progress: normalizedProgress(body),
      resultUrl: resultUrlFrom(body),
      error: phase === "failed" ? providerMessage(body, `Video task failed with status ${providerStatus}`) : null,
      raw: body,
    };
    if (phase === "succeeded" && !status.resultUrl) {
      throw new VideoApiError("invalid_response", "Completed video task does not contain a result URL", undefined, undefined, body);
    }
    return status;
  }

  async waitForResult(
    taskId: string,
    options: VideoRequestOptions & {
      pollIntervalMs?: number;
      onProgress?: (status: VideoTaskStatus) => void;
    } = {},
  ): Promise<CompletedVideoTask> {
    const timeoutMs = positive(options.timeoutMs ?? this.overallTimeoutMs, "timeoutMs");
    const intervalMs = positive(options.pollIntervalMs ?? this.pollIntervalMs, "pollIntervalMs");
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        if (options.signal?.aborted) throw options.signal.reason;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new VideoApiError("timeout", `Video task timed out after ${timeoutMs}ms`);
        const status = await this.poll(taskId, {
          signal: options.signal,
          timeoutMs: Math.min(this.requestTimeoutMs, remaining),
        });
        options.onProgress?.(status);
        if (status.phase === "failed") {
          throw new VideoApiError("provider_failed", status.error ?? "Video task failed", undefined, undefined, status.raw);
        }
        if (status.phase === "succeeded") return status as CompletedVideoTask;
        const wait = Math.min(intervalMs, deadline - Date.now());
        if (wait <= 0) throw new VideoApiError("timeout", `Video task timed out after ${timeoutMs}ms`);
        await delay(wait, options.signal);
      }
    } catch (error) {
      if (error instanceof VideoApiError) throw error;
      if (options.signal?.aborted) {
        throw new VideoApiError("cancelled", "Video task polling was cancelled", undefined, undefined, undefined, { cause: error });
      }
      throw error;
    }
  }

  async downloadResult(
    resultUrl: string,
    options: {
      outputDirectory: string;
      stem: string;
      fileName?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      maxBytes?: number;
      retryDelayMs?: number;
    },
  ): Promise<DownloadedVideo> {
    let url: URL;
    try {
      url = new URL(resultUrl, `${this.options.baseUrl.replace(/\/+$/, "")}/`);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    } catch (cause) {
      throw new VideoApiError("invalid_response", "Video result URL must use HTTP or HTTPS", undefined, undefined, undefined, { cause });
    }
    const timeoutMs = positive(options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS, "download timeoutMs");
    const maxBytes = positive(options.maxBytes ?? DEFAULT_MAX_VIDEO_BYTES, "maxBytes");
    const retryDelayMs = options.retryDelayMs === undefined ? DOWNLOAD_RETRY_DELAY_MS : Math.max(0, options.retryDelayMs);
    await mkdir(options.outputDirectory, { recursive: true });
    let lastError: VideoApiError | null = null;
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      const abort = combineAbort(options.signal, timeoutMs);
      const temporary = join(options.outputDirectory, `.${safeStem(options.stem)}-${randomUUID()}.part`);
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        const headers: Record<string, string> = { accept: "video/*,application/octet-stream" };
        if (this.options.sendAuthToResult) Object.assign(headers, this.authenticationHeaders());
        const response = await awaitWithAbort(
          this.fetcher(url, { method: "GET", headers, redirect: "follow", signal: abort.signal }),
          abort.signal,
        );
        if (!response.ok) {
          throw new VideoApiError(
            errorKind(response.status),
            `Video download failed with HTTP ${response.status}`,
            response.status,
            response.headers.get("x-request-id") ?? undefined,
          );
        }
        const mimeType = response.headers.get("content-type");
        if (isExplicitNonVideoMime(mimeType)) {
          throw new VideoApiError("download", `Video download returned non-video content type: ${mimeType}`);
        }
        const contentLengthHeader = response.headers.get("content-length");
        const contentLength = contentLengthHeader && /^\d+$/.test(contentLengthHeader) ? Number(contentLengthHeader) : null;
        if (contentLength !== null && contentLength > maxBytes) {
          throw new VideoApiError("download", `Video download exceeds ${maxBytes} byte limit`);
        }
        if (!response.body) throw new VideoApiError("download", "Video download response has no body");

        handle = await open(temporary, "wx");
        let total = 0;
        let firstBytes = Buffer.alloc(0);
        for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (abort.signal.aborted) throw abort.signal.reason;
          const chunk = Buffer.from(value);
          total += chunk.length;
          if (total > maxBytes) throw new VideoApiError("download", `Video download exceeds ${maxBytes} byte limit`);
          if (firstBytes.length < 32) {
            firstBytes = Buffer.concat([firstBytes, chunk.subarray(0, 32 - firstBytes.length)]);
          }
          let offset = 0;
          while (offset < chunk.length) {
            const result = await handle.write(chunk, offset, chunk.length - offset);
            if (result.bytesWritten <= 0) throw new Error("Unable to write downloaded video");
            offset += result.bytesWritten;
          }
        }
        if (contentLength !== null && total !== contentLength) {
          throw new VideoApiError("download", `Video download is incomplete: ${total}/${contentLength} bytes`);
        }
        if (total < MIN_VIDEO_BYTES) {
          throw new VideoApiError("download", `Downloaded video is too small: ${total} bytes`);
        }
        await handle.sync();
        await handle.close();
        handle = null;

        const extension = extensionFromMime(mimeType) ?? extensionFromBytes(firstBytes);
        if (!extension) throw new VideoApiError("download", "Downloaded result is not a recognized video format");
        const requestedStem = options.fileName?.trim()
          ? options.fileName.trim().replace(/\.[a-z0-9]+$/i, "")
          : "";
        const destination = join(
          options.outputDirectory,
          requestedStem
            ? `${safeStem(requestedStem)}.${extension}`
            : `${safeStem(options.stem)}-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`,
        );
        if (requestedStem) await rm(destination, { force: true });
        await rename(temporary, destination);
        return { path: destination, bytes: total, mimeType };
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        if (options.signal?.aborted) {
          throw new VideoApiError("cancelled", "Video download was cancelled", undefined, undefined, undefined, { cause: error });
        }
        lastError = abort.didTimeout()
          ? new VideoApiError("timeout", `Video download timed out after ${timeoutMs}ms`, undefined, undefined, undefined, { cause: error })
          : error instanceof VideoApiError
            ? error
            : new VideoApiError("download", "Unable to download video result", undefined, undefined, undefined, { cause: error });
      } finally {
        abort.cleanup();
      }
      if (attempt < DOWNLOAD_ATTEMPTS) {
        try {
          await delay(retryDelayMs * attempt, options.signal);
        } catch (error) {
          throw new VideoApiError("cancelled", "Video download was cancelled", undefined, undefined, undefined, { cause: error });
        }
      }
    }
    throw lastError ?? new VideoApiError("download", "Unable to download video result");
  }

  private authenticationHeaders(): Record<string, string> {
    if (!this.options.apiKey) return {};
    const header = this.options.apiKeyHeader?.trim() || "authorization";
    return {
      [header]: header.toLowerCase() === "authorization" ? `Bearer ${this.options.apiKey}` : this.options.apiKey,
    };
  }

  private async requestJson(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    requestOptions?: VideoRequestOptions,
  ): Promise<unknown> {
    const timeoutMs = positive(requestOptions?.timeoutMs ?? this.requestTimeoutMs, "request timeoutMs");
    const abort = combineAbort(requestOptions?.signal, timeoutMs);
    try {
      const response = await awaitWithAbort(
        this.fetcher(buildEndpoint(this.options.baseUrl, path), {
          method,
          headers: {
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...this.options.headers,
            ...this.authenticationHeaders(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: abort.signal,
        }),
        abort.signal,
      );
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
        throw new VideoApiError("invalid_response", "Video API JSON response is too large", response.status);
      }
      const raw = await awaitWithAbort(response.text(), abort.signal);
      if (Buffer.byteLength(raw) > MAX_JSON_BYTES) {
        throw new VideoApiError("invalid_response", "Video API JSON response is too large", response.status);
      }
      let parsed: unknown = null;
      if (raw) {
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch (cause) {
          throw new VideoApiError("invalid_response", "Video API returned invalid JSON", response.status, undefined, raw, { cause });
        }
      }
      if (!response.ok) {
        throw new VideoApiError(
          errorKind(response.status),
          providerMessage(parsed, `Video API request failed with HTTP ${response.status}`),
          response.status,
          response.headers.get("x-request-id") ?? undefined,
          parsed,
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof VideoApiError) throw error;
      if (abort.didTimeout()) {
        throw new VideoApiError("timeout", `Video API request timed out after ${timeoutMs}ms`, undefined, undefined, undefined, { cause: error });
      }
      if (requestOptions?.signal?.aborted) {
        throw new VideoApiError("cancelled", "Video API request was cancelled", undefined, undefined, undefined, { cause: error });
      }
      throw new VideoApiError("network", "Video API network request failed", undefined, undefined, undefined, { cause: error });
    } finally {
      abort.cleanup();
    }
  }
}
