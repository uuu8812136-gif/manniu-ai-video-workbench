import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalMediaProtocolHandler, parseSingleByteRange } from "../src/main/local-media-protocol";
import { localMediaUrl, parseLocalMediaUrl, standaloneImageUrl } from "../src/shared/local-media";

const VIDEO = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "ascii"), Buffer.alloc(32, 7)]);
const IMAGE = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const STANDALONE_JOB_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("opaque local media protocol", () => {
  let root: string;
  let videoPath: string;
  let imagePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ai-tool-local-media-中文-"));
    videoPath = join(root, "视频 #1 100%.mp4");
    imagePath = join(root, "图片 #1 100%.png");
    await writeFile(videoPath, VIDEO);
    await writeFile(imagePath, IMAGE);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function handler(overrides: { videoPath?: string | null; imagePaths?: string[] } = {}) {
    return createLocalMediaProtocolHandler({
      get: (id) => {
        if (id !== 42) throw new Error("not found");
        return {
          videoPath: overrides.videoPath === undefined ? videoPath : overrides.videoPath,
          imagePaths: overrides.imagePaths ?? [imagePath],
        };
      },
    });
  }

  function standaloneHandler(output: unknown = { imagePaths: [imagePath] }) {
    return createLocalMediaProtocolHandler(
      { get: () => ({ videoPath: null, imagePaths: [] }) },
      { get: (id) => id === STANDALONE_JOB_ID ? { type: "image.standalone", output } : null },
    );
  }

  it("builds stable URLs without exposing an absolute path and parses only canonical routes", () => {
    expect(localMediaUrl({ storyboardId: 42, kind: "video" })).toBe("aitool-media://storyboard/42/video");
    expect(localMediaUrl({ storyboardId: 42, kind: "image", imageIndex: 3 }, "2026-07-26T01:02:03Z"))
      .toBe("aitool-media://storyboard/42/image/3?v=2026-07-26T01%3A02%3A03Z");
    expect(parseLocalMediaUrl("aitool-media://storyboard/42/video?v=revision")).toEqual({ storyboardId: 42, kind: "video" });
    expect(parseLocalMediaUrl("aitool-media://storyboard/42/image/3")).toEqual({ storyboardId: 42, kind: "image", imageIndex: 3 });
    expect(standaloneImageUrl(STANDALONE_JOB_ID, 0)).toBe(`aitool-media://job/${STANDALONE_JOB_ID}/image/0`);
    expect(parseLocalMediaUrl(standaloneImageUrl(STANDALONE_JOB_ID, 2))).toEqual({
      jobId: STANDALONE_JOB_ID,
      kind: "standalone-image",
      imageIndex: 2,
    });
    expect(() => localMediaUrl({ storyboardId: 0, kind: "video" })).toThrow("storyboardId");
    expect(() => localMediaUrl({ storyboardId: 42, kind: "image", imageIndex: -1 })).toThrow("imageIndex");

    for (const invalid of [
      "aitool-media://storyboard/0/video",
      "aitool-media://storyboard/01/video",
      "aitool-media://storyboard/42/image/-1",
      "aitool-media://storyboard/42/image/01",
      "aitool-media://storyboard/42/image/0/extra",
      "aitool-media://storyboard/42/video?path=C%3A%5Csecret.txt",
      "aitool-media://storyboard/42/video?v=one&v=two",
      "aitool-media://storyboard/42/image/../video",
      "aitool-media://storyboard/42/image/%2e%2e/video",
      "aitool-media://storyboard/42/image/%2fvideo",
      "aitool-media://other/42/video",
      "aitool-media://job/not-a-uuid/image/0",
      `aitool-media://job/${STANDALONE_JOB_ID}/video/0`,
      "https://storyboard/42/video",
    ]) {
      expect(parseLocalMediaUrl(invalid), invalid).toBeNull();
    }
  });

  it("serves only image paths bound to standalone image job output", async () => {
    const image = await standaloneHandler()(new Request(standaloneImageUrl(STANDALONE_JOB_ID, 0)));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(IMAGE);

    expect((await standaloneHandler()(new Request(standaloneImageUrl(STANDALONE_JOB_ID, 1)))).status).toBe(404);
    expect((await standaloneHandler({ imagePaths: [videoPath] })(new Request(standaloneImageUrl(STANDALONE_JOB_ID, 0)))).status).toBe(415);
    const wrongType = createLocalMediaProtocolHandler(
      { get: () => ({ videoPath: null, imagePaths: [] }) },
      { get: () => ({ type: "image.generate", output: { imagePaths: [imagePath] } }) },
    );
    expect((await wrongType(new Request(standaloneImageUrl(STANDALONE_JOB_ID, 0)))).status).toBe(404);
  });

  it("serves only database-bound video and indexed image files with explicit MIME types", async () => {
    const serve = handler();
    const video = await serve(new Request(localMediaUrl({ storyboardId: 42, kind: "video" })));
    expect(video.status).toBe(200);
    expect(video.headers.get("content-type")).toBe("video/mp4");
    expect(video.headers.get("content-length")).toBe(String(VIDEO.length));
    expect(video.headers.get("accept-ranges")).toBe("bytes");
    expect(video.headers.get("cache-control")).toBe("private, no-store");
    expect(video.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await video.arrayBuffer())).toEqual(VIDEO);

    const image = await serve(new Request(localMediaUrl({ storyboardId: 42, kind: "image", imageIndex: 0 })));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(IMAGE);

    const unbound = await serve(new Request(localMediaUrl({ storyboardId: 42, kind: "image", imageIndex: 1 })));
    expect(unbound.status).toBe(404);
    expect(await unbound.text()).toBe("");
    const unknownStoryboard = await serve(new Request(localMediaUrl({ storyboardId: 43, kind: "video" })));
    expect(unknownStoryboard.status).toBe(404);
  });

  it("supports GET and HEAD byte ranges and rejects unsatisfiable or multipart ranges", async () => {
    const serve = handler();
    const url = localMediaUrl({ storyboardId: 42, kind: "video" });
    const partial = await serve(new Request(url, { headers: { Range: "bytes=4-11" } }));
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 4-11/${VIDEO.length}`);
    expect(partial.headers.get("content-length")).toBe("8");
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(VIDEO.subarray(4, 12));

    const suffix = await serve(new Request(url, { headers: { Range: "bytes=-5" } }));
    expect(suffix.status).toBe(206);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(VIDEO.subarray(-5));

    const head = await serve(new Request(url, { method: "HEAD", headers: { Range: "bytes=0-3" } }));
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe(`bytes 0-3/${VIDEO.length}`);
    expect(head.headers.get("content-length")).toBe("4");
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    for (const range of ["items=0-1", "bytes=", "bytes=9-3", `bytes=${VIDEO.length}-`, "bytes=0-1,3-4"]) {
      const invalid = await serve(new Request(url, { headers: { Range: range } }));
      expect(invalid.status, range).toBe(416);
      expect(invalid.headers.get("content-range"), range).toBe(`bytes */${VIDEO.length}`);
      expect(await invalid.text()).toBe("");
    }
    expect(parseSingleByteRange("bytes=2-999", 10)).toEqual({ start: 2, end: 9 });
    expect(parseSingleByteRange(null, 10)).toBeNull();
  });

  it("rejects methods, missing files, directories, relative paths, and kind/extension mismatches without leaking paths", async () => {
    const url = localMediaUrl({ storyboardId: 42, kind: "video" });
    const post = await handler()(new Request(url, { method: "POST" }));
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");

    const missingPath = join(root, "已删除.mp4");
    const missing = await handler({ videoPath: missingPath })(new Request(url));
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain(missingPath);

    const directoryPath = join(root, "目录.mp4");
    await mkdir(directoryPath);
    expect((await handler({ videoPath: directoryPath })(new Request(url))).status).toBe(404);
    expect((await handler({ videoPath: "relative.mp4" })(new Request(url))).status).toBe(404);
    expect((await handler({ videoPath: imagePath })(new Request(url))).status).toBe(415);
    const imageUrl = localMediaUrl({ storyboardId: 42, kind: "image", imageIndex: 0 });
    expect((await handler({ imagePaths: [videoPath] })(new Request(imageUrl))).status).toBe(415);
  });
});
