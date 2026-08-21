export const LOCAL_MEDIA_SCHEME = "aitool-media";

export type LocalMediaReference =
  | { storyboardId: number; kind: "video" }
  | { storyboardId: number; kind: "image"; imageIndex: number }
  | { jobId: string; kind: "standalone-image"; imageIndex: number };

export type LocalMediaSelector =
  | { storyboardId: number; kind: "video"; index?: never }
  | { storyboardId: number; kind: "image"; index: number };

export function localMediaReference(selector: LocalMediaSelector): LocalMediaReference {
  return selector.kind === "video"
    ? { storyboardId: selector.storyboardId, kind: "video" }
    : { storyboardId: selector.storyboardId, kind: "image", imageIndex: selector.index };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
  return value;
}

export function localMediaUrl(reference: LocalMediaReference, version?: string): string {
  if (reference.kind === "standalone-image") return standaloneImageUrl(reference.jobId, reference.imageIndex, version);
  const storyboardId = positiveInteger(reference.storyboardId, "storyboardId");
  const suffix = reference.kind === "video"
    ? "video"
    : `image/${nonnegativeInteger(reference.imageIndex, "imageIndex")}`;
  const url = new URL(`${LOCAL_MEDIA_SCHEME}://storyboard/${storyboardId}/${suffix}`);
  if (version) url.searchParams.set("v", version);
  return url.toString();
}

export function standaloneImageUrl(jobId: string, imageIndex: number, version?: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    throw new TypeError("jobId must be a UUID");
  }
  const url = new URL(`${LOCAL_MEDIA_SCHEME}://job/${jobId}/image/${nonnegativeInteger(imageIndex, "imageIndex")}`);
  if (version) url.searchParams.set("v", version);
  return url.toString();
}

export function storyboardMediaUrl(input: LocalMediaSelector & { version?: string }): string {
  const { version, ...selector } = input;
  return localMediaUrl(localMediaReference(selector as LocalMediaSelector), version);
}

export function parseLocalMediaUrl(value: string): LocalMediaReference | null {
  const rawRoute = value.split(/[?#]/, 1)[0] ?? "";
  if (/\\|%(?:2e|2f|5c)/i.test(rawRoute) || /\/\.{1,2}(?:\/|$)/.test(rawRoute)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${LOCAL_MEDIA_SCHEME}:`
    || (url.hostname !== "storyboard" && url.hostname !== "job")
    || url.username
    || url.password
    || url.port
    || url.hash
  ) {
    return null;
  }
  const versionValues = url.searchParams.getAll("v");
  if ([...url.searchParams.keys()].some((key) => key !== "v") || versionValues.length > 1 || (versionValues[0]?.length ?? 0) > 240) {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "job") {
    if (
      parts.length !== 3
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parts[0] ?? "")
      || parts[1] !== "image"
      || !/^(?:0|[1-9]\d*)$/.test(parts[2] ?? "")
    ) return null;
    const imageIndex = Number(parts[2]);
    if (!Number.isSafeInteger(imageIndex)) return null;
    return { jobId: parts[0], kind: "standalone-image", imageIndex };
  }
  if (url.hostname !== "storyboard") return null;
  if (!/^[1-9]\d*$/.test(parts[0] ?? "")) return null;
  const storyboardId = Number(parts[0]);
  if (!Number.isSafeInteger(storyboardId)) return null;
  if (parts.length === 2 && parts[1] === "video") return { storyboardId, kind: "video" };
  if (parts.length !== 3 || parts[1] !== "image" || !/^(?:0|[1-9]\d*)$/.test(parts[2] ?? "")) return null;
  const imageIndex = Number(parts[2]);
  if (!Number.isSafeInteger(imageIndex)) return null;
  return { storyboardId, kind: "image", imageIndex };
}
