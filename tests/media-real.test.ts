import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkMediaHealth, probeMedia, runFfmpeg } from "../src/main/media";

const ffmpegPath = process.env.AI_TOOL_REAL_FFMPEG_PATH?.trim();
const ffprobePath = process.env.AI_TOOL_REAL_FFPROBE_PATH?.trim();
const realMediaSuite = ffmpegPath && ffprobePath ? describe : describe.skip;

realMediaSuite("real FFmpeg integration", () => {
  let root: string;
  let outputPath: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "AI工具 真实媒体验收 "));
    outputPath = join(root, "中文 测试视频.mp4");
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("generates and probes an actual video through the controlled wrappers", async () => {
    const health = await checkMediaHealth({ ffmpegPath, ffprobePath, timeoutMs: 10_000 });
    expect(health.ok).toBe(true);

    const generated = await runFfmpeg(
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=1:size=320x180:rate=24",
        "-c:v",
        "mpeg4",
        "-pix_fmt",
        "yuv420p",
        outputPath,
      ],
      { ffmpegPath, timeoutMs: 30_000 },
    );
    expect(generated.exitCode).toBe(0);
    expect(existsSync(outputPath)).toBe(true);
    expect((await stat(outputPath)).size).toBeGreaterThan(1_000);

    const probed = await probeMedia(outputPath, { ffprobePath, timeoutMs: 10_000 });
    expect(probed.streams?.some((stream) => stream.codec_type === "video")).toBe(true);
    expect(Number(probed.format?.duration)).toBeGreaterThan(0.9);
  });
});
