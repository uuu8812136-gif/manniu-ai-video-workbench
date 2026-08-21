import { lstat, open } from "node:fs/promises";
import { isAbsolute, extname } from "node:path";
import { Readable } from "node:stream";
import type { Storyboard } from "../shared/contracts";
import { parseLocalMediaUrl, type LocalMediaReference } from "../shared/local-media";

type StoryboardMediaLookup = {
  get(id: number): Pick<Storyboard, "videoPath" | "imagePaths">;
};

type JobMediaLookup = {
  get(id: string): { type: string; output: unknown } | null;
};

type ByteRange = { start: number; end: number };

const VIDEO_MIME_TYPES = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".mkv", "video/x-matroska"],
  [".avi", "video/x-msvideo"],
]);

const IMAGE_MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
]);

function response(status: number, headers?: HeadersInit): Response {
  return new Response(null, { status, headers });
}

function unsatisfiable(size: number): Response {
  return response(416, {
    "Accept-Ranges": "bytes",
    "Content-Range": `bytes */${size}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
}

export function parseSingleByteRange(value: string | null, size: number): ByteRange | null | "invalid" {
  if (value === null) return null;
  if (!Number.isSafeInteger(size) || size < 0 || !value.startsWith("bytes=") || value.includes(",")) return "invalid";
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return "invalid";
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || requestedEnd < start
    || start >= size
  ) {
    return "invalid";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function mimeType(kind: "video" | "image", filePath: string): string | null {
  const types = kind === "video" ? VIDEO_MIME_TYPES : IMAGE_MIME_TYPES;
  return types.get(extname(filePath).toLowerCase()) ?? null;
}

function boundMediaReference(
  storyboards: StoryboardMediaLookup,
  reference: LocalMediaReference,
  jobs?: JobMediaLookup,
): { path: string; kind: "video" | "image" } | null {
  if (reference.kind === "standalone-image") {
    const job = jobs?.get(reference.jobId);
    if (!job || job.type !== "image.standalone" || !job.output || typeof job.output !== "object") return null;
    const imagePaths = (job.output as { imagePaths?: unknown }).imagePaths;
    const path = Array.isArray(imagePaths) ? imagePaths[reference.imageIndex] : null;
    return typeof path === "string" && isAbsolute(path) ? { path, kind: "image" } : null;
  }
  let storyboard: Pick<Storyboard, "videoPath" | "imagePaths">;
  try {
    storyboard = storyboards.get(reference.storyboardId);
  } catch {
    return null;
  }
  const path = reference.kind === "video"
    ? storyboard.videoPath
    : storyboard.imagePaths[reference.imageIndex];
  if (!path || !isAbsolute(path)) return null;
  return { path, kind: reference.kind };
}

export async function resolveBoundLocalMediaFile(
  storyboards: StoryboardMediaLookup,
  reference: LocalMediaReference,
  jobs?: JobMediaLookup,
): Promise<string | null> {
  const media = boundMediaReference(storyboards, reference, jobs);
  if (!media || !mimeType(media.kind, media.path)) return null;
  try {
    const info = await lstat(media.path);
    return info.isFile() && !info.isSymbolicLink() ? media.path : null;
  } catch {
    return null;
  }
}

function fileErrorStatus(error: unknown): number {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "ENOENT" || code === "ENOTDIR") return 404;
  if (code === "EACCES" || code === "EPERM") return 403;
  return 500;
}

export function createLocalMediaProtocolHandler(storyboards: StoryboardMediaLookup, jobs?: JobMediaLookup): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return response(405, { Allow: "GET, HEAD", "Cache-Control": "private, no-store" });
    }
    const reference = parseLocalMediaUrl(request.url);
    const media = reference ? boundMediaReference(storyboards, reference, jobs) : null;
    if (!media) return response(404, { "Cache-Control": "private, no-store" });
    const contentType = mimeType(media.kind, media.path);
    if (!contentType) return response(415, { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });

    let fileHandle;
    try {
      const pathInfo = await lstat(media.path);
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) return response(404, { "Cache-Control": "private, no-store" });
      fileHandle = await open(media.path, "r");
      const openInfo = await fileHandle.stat();
      if (!openInfo.isFile() || pathInfo.dev !== openInfo.dev || pathInfo.ino !== openInfo.ino) {
        await fileHandle.close();
        return response(409, { "Cache-Control": "private, no-store" });
      }
      const range = parseSingleByteRange(request.headers.get("range"), openInfo.size);
      if (range === "invalid") {
        await fileHandle.close();
        return unsatisfiable(openInfo.size);
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? Math.max(0, openInfo.size - 1);
      const length = range ? end - start + 1 : openInfo.size;
      const headers = new Headers({
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Length": String(length),
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
      });
      if (range) headers.set("Content-Range", `bytes ${start}-${end}/${openInfo.size}`);
      if (request.method === "HEAD" || openInfo.size === 0) {
        await fileHandle.close();
        return new Response(null, { status: range ? 206 : 200, headers });
      }
      const stream = fileHandle.createReadStream({ start, end, autoClose: true });
      const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch (error) {
      await fileHandle?.close().catch(() => undefined);
      return response(fileErrorStatus(error), { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    }
  };
}
