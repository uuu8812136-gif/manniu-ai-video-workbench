import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportJianyingDraft,
  hydrateJianyingMediaMetadata,
  mediaDurationUs,
  validateJianyingDraft,
} from "../src/main/jianying";

describe("Jianying draft export", () => {
  it("hydrates real video/audio durations and video dimensions before export", async () => {
    const probe = vi.fn(async (filePath: string) => filePath.endsWith(".mp4")
      ? { format: { duration: "8.25" }, streams: [{ codec_type: "video", width: 1080, height: 1920 }] }
      : { streams: [{ codec_type: "audio", duration: "12.5" }] });
    const hydrated = await hydrateJianyingMediaMetadata({
      draftRoot: root,
      projectName: "探测项目",
      visualClips: [{ filePath: join(root, "clip.mp4"), durationUs: 4_000_000, kind: "video" }],
      audioClips: [{ filePath: join(root, "voice.wav"), durationUs: 10_000_000 }],
    }, {}, probe);

    expect(hydrated.visualClips?.[0]).toMatchObject({ sourceDurationUs: 8_250_000, width: 1080, height: 1920 });
    expect(hydrated.audioClips?.[0]).toMatchObject({ sourceDurationUs: 12_500_000 });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(mediaDurationUs({ format: { duration: "0" }, streams: [] })).toBeNull();
  });

  it("keeps ordinary video clips at source speed and reflows their timeline", async () => {
    const probe = vi.fn(async () => ({ format: { duration: "7.5" }, streams: [{ codec_type: "video" }] }));
    const hydrated = await hydrateJianyingMediaMetadata({
      draftRoot: root,
      projectName: "原速项目",
      timelineDurationUs: 9_000_000,
      preserveVisualSpeed: true,
      visualClips: [
        { filePath: join(root, "clip-a.mp4"), durationUs: 4_000_000, startUs: 0, kind: "video" },
        { filePath: join(root, "clip-b.mp4"), durationUs: 4_000_000, startUs: 5_000_000, kind: "video" },
      ],
    }, {}, probe);

    expect(hydrated.visualClips).toMatchObject([
      { durationUs: 7_500_000, startUs: 0, sourceDurationUs: 7_500_000 },
      { durationUs: 7_500_000, startUs: 8_500_000, sourceDurationUs: 7_500_000 },
    ]);
    expect(hydrated.timelineDurationUs).toBe(16_000_000);
  });
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "AI工具 剪映测试 "));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a validated draft with copied media and linked tracks", async () => {
    const inputPath = join(root, "输入 素材");
    await writeFile(inputPath, "placeholder image bytes");
    const audioPath = join(root, "旁白 音频.wav");
    await writeFile(audioPath, "placeholder audio bytes");
    const draftRoot = join(root, "剪映草稿 根目录");

    const exported = await exportJianyingDraft({
      draftRoot,
      projectName: "中文 项目 01",
      visualClips: [
        { filePath: inputPath, durationUs: 2_000_000, kind: "photo", width: 1_920, height: 1_080 },
        { filePath: inputPath, durationUs: 2_000_000, kind: "photo", width: 1_920, height: 1_080 },
      ],
      audioClips: [{ filePath: audioPath, durationUs: 4_000_000 }],
      subtitles: [
        { text: "第一句字幕", startUs: 0, endUs: 2_000_000 },
        { text: "第二句字幕", startUs: 2_000_000, endUs: 4_000_000 },
      ],
    });

    expect(exported.validation.valid).toBe(true);
    expect(exported.durationUs).toBe(4_000_000);
    expect(exported.validation.summary).toMatchObject({ tracks: 3, segments: 5 });
    expect(await stat(exported.contentPath)).toMatchObject({ size: expect.any(Number) });
    expect(await stat(exported.metaPath)).toMatchObject({ size: expect.any(Number) });
    for (const materialPath of exported.materialPaths) expect((await stat(materialPath)).isFile()).toBe(true);

    const content = JSON.parse(await readFile(exported.contentPath, "utf8")) as {
      duration: number;
      tracks: Array<{ type: string; segments: unknown[] }>;
      materials: { videos: Array<{ path: string }>; audios: Array<{ path: string }> };
    };
    expect(content.duration).toBe(4_000_000);
    expect(content.tracks.map((item) => item.type)).toEqual(["video", "audio", "text"]);
    expect(content.materials.videos).toHaveLength(2);
    expect(content.materials.audios).toHaveLength(1);
  });

  it("creates a valid full-length black draft without visual materials", async () => {
    const exported = await exportJianyingDraft({
      draftRoot: join(root, "black-drafts"),
      projectName: "全黑占位",
      timelineDurationUs: 12_000_000,
    });

    expect(exported.validation.valid).toBe(true);
    expect(exported.durationUs).toBe(12_000_000);
    expect(exported.validation.summary).toMatchObject({ tracks: 1, segments: 1, durationUs: 12_000_000 });
    expect(await stat(exported.materialPaths[0])).toMatchObject({ size: expect.any(Number) });
  });

  it("reflows overlapping visual and black clips into one valid video track", async () => {
    const imagePath = join(root, "scene.png");
    await writeFile(imagePath, "image bytes");
    const exported = await exportJianyingDraft({
      draftRoot: join(root, "overlap-drafts"),
      projectName: "重叠修复",
      visualClips: [{ filePath: imagePath, durationUs: 4_000_000, startUs: 0, kind: "photo" }],
      blackClips: [{ durationUs: 3_000_000, startUs: 2_000_000 }],
    });
    const content = JSON.parse(await readFile(exported.contentPath, "utf8")) as {
      tracks: Array<{ type: string; segments: Array<{ target_timerange: { start: number; duration: number } }> }>;
    };
    const videoTrack = content.tracks.find((item) => item.type === "video")!;

    expect(exported.validation.valid).toBe(true);
    expect(videoTrack.segments.map((segment) => segment.target_timerange)).toEqual([
      { start: 0, duration: 4_000_000 },
      { start: 4_000_000, duration: 3_000_000 },
    ]);
  });

  it("exports 166 mixed clips without overlapping the Jianying video track", async () => {
    const imagePath = join(root, "large-scene.png");
    await writeFile(imagePath, "image bytes");
    const visualClips = [];
    const blackClips = [];
    for (let index = 0; index < 166; index += 1) {
      const clip = { durationUs: 4_000_000, startUs: index * 2_000_000 };
      if (index % 5 === 0) blackClips.push(clip);
      else visualClips.push({ ...clip, filePath: imagePath, kind: "photo" as const });
    }

    const exported = await exportJianyingDraft({
      draftRoot: join(root, "large-drafts"),
      projectName: "166 分镜重叠修复",
      visualClips,
      blackClips,
    });
    const content = JSON.parse(await readFile(exported.contentPath, "utf8")) as {
      tracks: Array<{ type: string; segments: Array<{ target_timerange: { start: number; duration: number } }> }>;
    };
    const segments = content.tracks.find((item) => item.type === "video")!.segments;

    expect(exported.validation.valid).toBe(true);
    expect(segments).toHaveLength(166);
    for (let index = 1; index < segments.length; index += 1) {
      const previous = segments[index - 1].target_timerange;
      expect(segments[index].target_timerange.start).toBeGreaterThanOrEqual(previous.start + previous.duration);
    }
  });

  it("rejects broken material references and supports explicit overwrite", async () => {
    const imagePath = join(root, "scene.png");
    await writeFile(imagePath, "image bytes");
    const input = {
      draftRoot: join(root, "drafts"),
      projectName: "same-name",
      visualClips: [{ filePath: imagePath, durationUs: 1_000_000, kind: "photo" as const }],
    };
    const first = await exportJianyingDraft(input);
    await expect(exportJianyingDraft(input)).rejects.toThrow("草稿已存在");
    const replaced = await exportJianyingDraft({ ...input, overwrite: true });
    expect(replaced.validation.valid).toBe(true);

    const content = JSON.parse(await readFile(first.contentPath, "utf8")) as {
      tracks: Array<{ segments: Array<{ material_id: string }> }>;
    };
    content.tracks[0].segments[0].material_id = "BROKEN_REFERENCE";
    await writeFile(first.contentPath, JSON.stringify(content), "utf8");
    const validation = await validateJianyingDraft(first.draftPath);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("\n")).toContain("material_id");
  });
});
