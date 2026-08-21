import type { VideoTaskStatus } from "./video-client";
import { extractAssetNames } from "../shared/asset-names";

export type ViduModel = "Q2" | "Q3";
export type ViduAspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4";

const VIDU_ASPECT_RATIOS = new Set<ViduAspectRatio>(["16:9", "9:16", "1:1", "4:3", "3:4"]);

export type ViduMaterial = {
  id: string;
  name: string;
  version: string;
  url: string;
  raw: Record<string, unknown>;
};

export type ViduSubmitRequest = {
  projectId: number;
  prompt: string;
  durationSeconds: number;
  model: ViduModel;
  useCredits: boolean;
  aspectRatio?: string;
  projectDirectory: string;
  storyboardIndex?: number;
  nextSubjectAppearances?: Record<string, number>;
  subjects?: string[];
};

export type ViduDownloadOptions = {
  outputDirectory: string;
  stem: string;
  fileName?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  retryDelayMs?: number;
};

export type ViduThrottleState = {
  reason: "in_progress" | "rate_limit";
  inProgress: number | null;
  retryInMs: number;
};

export type ViduSubjectPreparationProgress = {
  phase: "start" | "progress" | "end";
  current: number;
  total: number;
  name: string;
};

export type ViduSubmitOptions = {
  signal?: AbortSignal;
  throttleProbeMs?: number;
  onThrottled?: (state: ViduThrottleState) => void;
  onThrottleRecovered?: (state: { inProgress: number }) => void;
  onSubjectPreparation?: (progress: ViduSubjectPreparationProgress) => void;
};

export interface ViduGenerationClient {
  submit(request: ViduSubmitRequest, options?: ViduSubmitOptions): Promise<{ taskId: string; raw: unknown }>;
  poll(taskId: string, options?: { signal?: AbortSignal }): Promise<VideoTaskStatus>;
  waitForResult(
    taskId: string,
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      pollIntervalMs?: number;
      onProgress?: (status: VideoTaskStatus) => void;
    },
  ): Promise<VideoTaskStatus & { phase: "succeeded"; resultUrl: string }>;
  downloadResult(
    resultUrl: string,
    options: ViduDownloadOptions,
  ): Promise<{ path: string; bytes: number; mimeType: string | null }>;
}

type JsonObject = Record<string, unknown>;

const VIDEO_CONTAINER_TOKENS = [
  "creations", "outputs", "output", "result", "results", "videos", "video",
  "files", "media", "asset", "assets", "resource", "resources", "payload", "data",
];
const VIDEO_URL_KEYS = new Set([
  "download_uri", "download_url", "downloadurl", "play_uri", "play_url", "playurl",
  "video_uri", "video_url", "videourl", "media_uri", "media_url", "mediaurl",
  "stream_uri", "stream_url", "streamurl", "uri", "url", "src",
]);
const POSITIVE_TOKENS = [
  "video", "download", "play", "stream", "media", "file", "asset", "result",
  "output", "creation", "resource", "render", "transcode", "source", "src",
];
const NEGATIVE_TOKENS = ["cover", "poster", "thumb", "thumbnail", "preview", "image", "avatar", "snapshot"];
const VIDEO_HINTS = [".mp4", ".mov", ".webm", ".m3u8", ".mkv", "/video", "video=", "download"];
const IMAGE_HINTS = [".jpg", ".jpeg", ".png", ".webp", ".gif", "/image", "thumbnail", "poster", "cover"];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractViduRoleNames(prompt: string): string[] {
  return extractAssetNames(prompt);
}

export function anchorViduRoleNames(prompt: string): string {
  return prompt.replace(/@([\w\u4e00-\u9fff]+)/gu, "[@$1]");
}

export function bindViduSubjects(prompt: string, subjects: string[] = []): string {
  let result = prompt;
  const names = [...new Set(subjects.map((name) => name.trim()).filter(Boolean))];
  for (const name of names) {
    if (result.includes(`@${name}`)) continue;
    const index = result.indexOf(name);
    if (index >= 0) {
      const after = result.slice(index + name.length);
      const separator = after && !/^[\s,，。.!?！？]/u.test(after) ? " " : "";
      result = `${result.slice(0, index)}@${name}${separator}${after}`;
    } else {
      result = `${result}${result.trim() ? "，" : ""}@${name}`;
    }
  }
  return result;
}

export function buildViduCharacterPayload(input: {
  prompt: string;
  materials: ViduMaterial[];
  durationSeconds: number;
  model: ViduModel;
  useCredits: boolean;
  aspectRatio?: string;
}): Record<string, unknown> {
  const q3 = input.model === "Q3";
  const aspectRatio = VIDU_ASPECT_RATIOS.has(input.aspectRatio as ViduAspectRatio)
    ? input.aspectRatio as ViduAspectRatio
    : "16:9";
  return {
    input: {
      prompts: [
        { type: "text", content: `${anchorViduRoleNames(input.prompt)}，4K，3D国漫风格，电影级画质` },
        ...input.materials.map((material) => ({
          type: "material",
          content: material.url,
          name: material.name,
          material: { id: String(material.id), version: String(material.version ?? "") },
        })),
      ],
      editor_mode: "normal",
      enhance: true,
    },
    type: "character2video",
    settings: {
      style: "",
      duration: Math.max(1, Math.round(input.durationSeconds)),
      aspect_ratio: aspectRatio,
      model: "vidu",
      model_version: q3 ? "3.2" : "3.1",
      resolution: "1080p",
      movement_amplitude: "auto",
      schedule_mode: input.useCredits ? "normal" : "nopeak",
      sample_count: 1,
      use_trial: false,
      is_locked: false,
      transition: q3 ? "pro" : "unspecified",
      with_audio: false,
      lip_sync: false,
      frame_durations: [],
      image_count: 0,
      codec: "h264",
      retain_original_audio: false,
      biz_scene: "unspecified",
      voice_lang: "",
      voice_id: "",
      speed: 0,
      volume: 0,
      grid_count: 0,
      subtitle_enable: false,
    },
  };
}

function taskIdAlias(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const result = taskIdAlias(child);
      if (result) return result;
    }
    return null;
  }
  if (!isObject(value)) return null;
  for (const key of ["task_id", "taskId"] as const) {
    const result = value[key];
    if ((typeof result === "string" || typeof result === "number") && String(result).trim()) return String(result).trim();
  }
  for (const child of Object.values(value)) {
    const result = taskIdAlias(child);
    if (result) return result;
  }
  return null;
}

export function extractViduSubmittedTaskId(value: unknown): string | null {
  return taskIdAlias(value);
}

export function extractViduTaskId(value: unknown): string | null {
  if (!isObject(value)) return taskIdAlias(value);
  for (const key of ["task_id", "taskId", "id"] as const) {
    const result = value[key];
    if ((typeof result === "string" || typeof result === "number") && String(result).trim()) return String(result).trim();
  }
  return taskIdAlias(Object.values(value));
}

export function viduTasks(value: unknown): JsonObject[] {
  if (!isObject(value)) return [];
  const direct = value.tasks;
  if (Array.isArray(direct)) return direct.filter(isObject);
  for (const key of ["data", "result", "payload"]) {
    const nested = viduTasks(value[key]);
    if (nested.length > 0) return nested;
  }
  return [];
}

function collectUrls(value: unknown, path: string[], output: Array<{ url: string; path: string[] }>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, path, output));
    return;
  }
  if (!isObject(value)) return;
  Object.entries(value).forEach(([rawKey, child]) => {
    const key = rawKey.trim().toLowerCase().replace(/-/g, "_");
    const nextPath = [...path, key];
    if (typeof child === "string" && /^https?:\/\//i.test(child)) output.push({ url: child, path: nextPath });
    else if (Array.isArray(child) || isObject(child)) collectUrls(child, nextPath, output);
  });
}

function scoreUrl(url: string, path: string[]): number {
  const lowerUrl = url.toLowerCase();
  const pathText = path.join(".");
  const last = path.at(-1) ?? "";
  let score = VIDEO_URL_KEYS.has(last) ? 14 : 0;
  if (VIDEO_CONTAINER_TOKENS.some((token) => pathText.includes(token))) score += 6;
  POSITIVE_TOKENS.forEach((token) => { if (pathText.includes(token)) score += 3; });
  NEGATIVE_TOKENS.forEach((token) => { if (pathText.includes(token)) score -= 8; });
  VIDEO_HINTS.forEach((hint) => { if (lowerUrl.includes(hint)) score += 5; });
  IMAGE_HINTS.forEach((hint) => { if (lowerUrl.includes(hint)) score -= 12; });
  return score;
}

export function extractViduVideoUrl(value: unknown): string | null {
  const candidates: Array<{ url: string; path: string[] }> = [];
  collectUrls(value, [], candidates);
  const ranked = candidates
    .map((candidate) => ({ ...candidate, score: scoreUrl(candidate.url, candidate.path) }))
    .sort((left, right) => right.score - left.score || right.url.length - left.url.length);
  return ranked[0] && ranked[0].score > 0 ? ranked[0].url : null;
}

function nestedCreationStates(value: unknown): string[] {
  if (!isObject(value) || !Array.isArray(value.creations)) return [];
  return value.creations
    .filter(isObject)
    .filter((creation) => !creation.type || creation.type === "video")
    .map((creation) => {
      const errorInfo = isObject(creation.err_info) ? creation.err_info : {};
      return String(creation.err_code ?? errorInfo.err_code ?? "").trim().toLowerCase();
    })
    .filter(Boolean);
}

export function normalizeViduTask(taskId: string, value: unknown): VideoTaskStatus {
  const object = isObject(value) ? value : {};
  let state = String(object.state ?? object.status ?? "").trim().toLowerCase();
  const resultUrl = extractViduVideoUrl(object);
  const creationStates = nestedCreationStates(object);
  const failed = new Set(["failed", "error", "canceled", "cancelled", "deleted"]);
  if (state === "success" && !resultUrl && creationStates.length > 0 && creationStates.every((item) => failed.has(item))) {
    state = "failed";
  }
  const providerStatus = state || "unknown";
  const phase = state === "success"
    ? "succeeded"
    : failed.has(state)
      ? "failed"
      : ["created", "queueing", "preparation", "scheduling"].includes(state)
        ? "pending"
        : "running";
  const progressValue = Number(object.progress ?? object.percentage ?? object.percent);
  const progress = Number.isFinite(progressValue)
    ? Math.max(0, Math.min(100, Math.round(progressValue > 0 && progressValue <= 1 ? progressValue * 100 : progressValue)))
    : null;
  const error = phase === "failed"
    ? String(object.message ?? object.error ?? object.err_msg ?? object.reason ?? `Vidu task ${providerStatus}`)
    : null;
  return { taskId, phase, providerStatus, progress, resultUrl, error, raw: value };
}
