import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GeneratedImage } from "./model-clients";

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

function extensionForMime(mimeType: string | null | undefined): string | null {
  const mime = mimeType?.split(";", 1)[0].trim().toLowerCase();
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return null;
}

function sniffExtension(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "gif";
  return null;
}

function safeStem(value: string): string {
  const normalized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "");
  return (normalized || "image").slice(0, 80);
}

function decodeBase64(value: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new Error("Image API returned invalid base64 data");
  if (compact.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) throw new Error("Generated image exceeds 50 MB limit");
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length === 0) throw new Error("Image API returned empty image data");
  return bytes;
}

async function downloadImage(
  url: string,
  signal: AbortSignal | undefined,
  fetcher: typeof fetch,
): Promise<{ bytes: Buffer; mimeType: string | null }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Image URL must use HTTP or HTTPS");
  const response = await fetcher(parsed, { signal, redirect: "follow", headers: { accept: "image/*" } });
  if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) throw new Error("Generated image exceeds 50 MB limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("Downloaded image is empty");
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Generated image exceeds 50 MB limit");
  return { bytes, mimeType: response.headers.get("content-type") };
}

export async function persistGeneratedImage(options: {
  image: GeneratedImage;
  outputDirectory: string;
  stem: string;
  replaceExisting?: boolean;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<string> {
  const fetched = options.image.base64
    ? { bytes: decodeBase64(options.image.base64), mimeType: options.image.mimeType ?? null }
    : options.image.url
      ? await downloadImage(options.image.url, options.signal, options.fetch ?? globalThis.fetch)
      : null;
  if (!fetched) throw new Error("Generated image has no downloadable content");
  const extension = sniffExtension(fetched.bytes) ?? extensionForMime(fetched.mimeType);
  if (!extension) throw new Error("Generated data is not a supported PNG, JPEG, WebP, or GIF image");

  await mkdir(options.outputDirectory, { recursive: true });
  const stem = safeStem(options.stem);
  const suffix = options.replaceExisting ? "" : `-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const destination = join(options.outputDirectory, `${stem}${suffix}.${extension}`);
  const temporary = `${destination}.${process.pid}.${Date.now()}-${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(temporary, fetched.bytes, { flag: "wx" });
    if (options.replaceExisting) {
      await Promise.all(["png", "jpg", "jpeg", "webp", "gif"]
        .filter((candidate) => candidate !== extension)
        .map((candidate) => rm(join(options.outputDirectory, `${stem}.${candidate}`), { force: true })));
      await rm(destination, { force: true });
    }
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
