import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  MediaProcessError,
  checkMediaHealth,
  resolveMediaBinaries,
  runControlledProcess,
  runFfmpeg,
} from "../src/main/media";

const packagedWindows = (files: string[] = []) => ({
  platform: "win32" as const,
  packaged: true,
  resourcesPath: "C:\\Program Files\\AI工具\\resources",
  isFile: (path: string) => files.includes(path),
});

describe("controlled media processes", () => {
  it("prefers bundled defaults in packaged Windows and falls back to PATH when absent", () => {
    const resourcesPath = packagedWindows().resourcesPath;
    const bundledFfmpeg = resolve(resourcesPath, "ffmpeg", "bin", "ffmpeg.exe");
    const bundledFfprobe = resolve(resourcesPath, "ffmpeg", "bin", "ffprobe.exe");

    expect(resolveMediaBinaries({}, packagedWindows([bundledFfmpeg, bundledFfprobe]))).toEqual({
      ffmpeg: bundledFfmpeg,
      ffprobe: bundledFfprobe,
    });
    expect(resolveMediaBinaries({}, packagedWindows([bundledFfmpeg]))).toEqual({
      ffmpeg: bundledFfmpeg,
      ffprobe: "ffprobe",
    });
    expect(resolveMediaBinaries({}, packagedWindows())).toEqual({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
  });

  it("keeps custom absolute and command paths ahead of bundled binaries", () => {
    const resourcesPath = packagedWindows().resourcesPath;
    const bundledFfmpeg = resolve(resourcesPath, "ffmpeg", "bin", "ffmpeg.exe");
    const bundledFfprobe = resolve(resourcesPath, "ffmpeg", "bin", "ffprobe.exe");
    const context = packagedWindows([bundledFfmpeg, bundledFfprobe]);

    expect(resolveMediaBinaries({
      ffmpegPath: "D:\\Media Tools\\ffmpeg-custom.exe",
      ffprobePath: "vendor-ffprobe",
    }, context)).toEqual({
      ffmpeg: "D:\\Media Tools\\ffmpeg-custom.exe",
      ffprobe: "vendor-ffprobe",
    });
  });

  it("uses PATH defaults outside packaged Windows even when a resource file is reported", () => {
    const context = {
      ...packagedWindows(["unused"]),
      packaged: false,
      isFile: () => true,
    };
    expect(resolveMediaBinaries({ ffmpegPath: "FFMPEG", ffprobePath: "ffprobe" }, context)).toEqual({
      ffmpeg: "FFMPEG",
      ffprobe: "ffprobe",
    });
  });

  it("captures stdout, stderr and exit status without a shell", async () => {
    const result = await runControlledProcess({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('ready'); process.stderr.write('diagnostic')"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ready");
    expect(result.stderr).toBe("diagnostic");
    expect(result.timedOut).toBe(false);
  });

  it("kills a process after its timeout", async () => {
    const result = await runControlledProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 80,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("stops a process that exceeds the output limit", async () => {
    const result = await runControlledProcess({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(20000)); setInterval(() => {}, 1000)"],
      maxOutputBytes: 1_024,
    });
    expect(result.outputLimitExceeded).toBe(true);
  });

  it("returns actionable health errors when binaries are missing", async () => {
    const missing = `missing-media-tool-${Date.now()}.exe`;
    const health = await checkMediaHealth({ ffmpegPath: missing, ffprobePath: missing, timeoutMs: 500 });
    expect(health.ok).toBe(false);
    expect(health.ffmpeg.error).toContain("无法启动");
    expect(health.ffprobe.error).toContain("无法启动");
  });

  it("turns FFmpeg failures into errors carrying stderr and the result", async () => {
    await expect(
      runFfmpeg(["-e", "process.stderr.write('编码失败'); process.exit(7)"], {
        ffmpegPath: process.execPath,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(MediaProcessError);
      const mediaError = error as MediaProcessError;
      expect(mediaError.result?.exitCode).not.toBe(0);
      return true;
    });
  });
});
