import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export type ControlledProcessOptions = {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
};

export type ControlledProcessResult = {
  executable: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
};

export class MediaProcessError extends Error {
  readonly result?: ControlledProcessResult;

  constructor(message: string, result?: ControlledProcessResult, options?: ErrorOptions) {
    super(message, options);
    this.name = "MediaProcessError";
    this.result = result;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} 必须是正整数`);
  return value;
}

export function runControlledProcess(options: ControlledProcessOptions): Promise<ControlledProcessResult> {
  const executable = options.executable.trim();
  if (!executable) return Promise.reject(new TypeError("executable 不能为空"));
  const args = options.args ?? [];
  if (!args.every((argument) => typeof argument === "string")) {
    return Promise.reject(new TypeError("所有进程参数都必须是字符串"));
  }
  const timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, "timeoutMs");
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 2 * 1024 * 1024, "maxOutputBytes");

  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let aborted = options.signal?.aborted ?? false;
    let outputLimitExceeded = false;
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new MediaProcessError(`无法启动 ${executable}`, undefined, { cause: error }));
      return;
    }

    const stop = (): void => {
      if (!child.killed) child.kill("SIGKILL");
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (aborted) stop();

    const capture = (target: Buffer[]) => (chunk: Buffer): void => {
      if (outputLimitExceeded) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        stop();
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", capture(stdout));
    child.stderr?.on("data", capture(stderr));

    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new MediaProcessError(`无法启动 ${executable}: ${error.message}`, undefined, { cause: error }));
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        executable,
        args,
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - startedAt,
        timedOut,
        aborted,
        outputLimitExceeded,
      });
    });
  });
}

export type MediaBinaryOptions = {
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  resolutionContext?: MediaBinaryResolutionContext;
};

export type MediaBinaryResolutionContext = {
  platform: NodeJS.Platform;
  packaged: boolean;
  resourcesPath?: string;
  isFile(path: string): boolean;
};

export type ResolvedMediaBinaries = {
  ffmpeg: string;
  ffprobe: string;
};

export type MediaToolHealth = {
  ok: boolean;
  executable: string;
  version: string | null;
  error: string | null;
  stderr: string;
};

export type MediaHealth = {
  ok: boolean;
  ffmpeg: MediaToolHealth;
  ffprobe: MediaToolHealth;
};

function defaultResolutionContext(): MediaBinaryResolutionContext {
  const electronProcess = process as NodeJS.Process & { defaultApp?: boolean; resourcesPath?: string };
  const resourcesPath = electronProcess.resourcesPath?.trim();
  return {
    platform: process.platform,
    packaged: Boolean(resourcesPath) && electronProcess.defaultApp !== true,
    resourcesPath,
    isFile: (filePath) => {
      try {
        return statSync(filePath).isFile();
      } catch {
        return false;
      }
    },
  };
}

function resolveMediaBinary(
  name: "ffmpeg" | "ffprobe",
  configuredPath: string | undefined,
  context: MediaBinaryResolutionContext,
): string {
  const configured = configuredPath?.trim() || name;
  const isDefaultCommand = context.platform === "win32"
    ? configured.toLowerCase() === name
    : configured === name;
  if (!isDefaultCommand) return configured;
  if (context.platform !== "win32" || !context.packaged || !context.resourcesPath?.trim()) return configured;

  const bundled = resolve(context.resourcesPath, "ffmpeg", "bin", `${name}.exe`);
  return context.isFile(bundled) ? bundled : configured;
}

export function resolveMediaBinaries(
  options: Pick<MediaBinaryOptions, "ffmpegPath" | "ffprobePath">,
  context: MediaBinaryResolutionContext,
): ResolvedMediaBinaries {
  return {
    ffmpeg: resolveMediaBinary("ffmpeg", options.ffmpegPath, context),
    ffprobe: resolveMediaBinary("ffprobe", options.ffprobePath, context),
  };
}

function resolvedMediaBinaries(options: MediaBinaryOptions): ResolvedMediaBinaries {
  return resolveMediaBinaries(options, options.resolutionContext ?? defaultResolutionContext());
}

async function checkBinary(executable: string, options: MediaBinaryOptions): Promise<MediaToolHealth> {
  try {
    const result = await runControlledProcess({
      executable,
      args: ["-version"],
      timeoutMs: options.timeoutMs ?? 5_000,
      maxOutputBytes: options.maxOutputBytes ?? 256 * 1024,
      signal: options.signal,
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const version = output.split(/\r?\n/, 1)[0] || null;
    const ok = result.exitCode === 0 && !result.timedOut && !result.aborted && !result.outputLimitExceeded;
    return {
      ok,
      executable,
      version,
      error: ok
        ? null
        : result.timedOut
          ? "健康检查超时"
          : result.aborted
            ? "健康检查已取消"
            : result.outputLimitExceeded
              ? "健康检查输出超过限制"
              : `进程退出码 ${result.exitCode ?? "unknown"}`,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      ok: false,
      executable,
      version: null,
      error: error instanceof Error ? error.message : String(error),
      stderr: "",
    };
  }
}

export async function checkMediaHealth(options: MediaBinaryOptions = {}): Promise<MediaHealth> {
  const binaries = resolvedMediaBinaries(options);
  const [ffmpeg, ffprobe] = await Promise.all([
    checkBinary(binaries.ffmpeg, options),
    checkBinary(binaries.ffprobe, options),
  ]);
  return { ok: ffmpeg.ok && ffprobe.ok, ffmpeg, ffprobe };
}

function assertSuccessful(result: ControlledProcessResult, label: string): ControlledProcessResult {
  if (
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.aborted &&
    !result.outputLimitExceeded
  ) {
    return result;
  }
  const reason = result.timedOut
    ? "执行超时"
    : result.aborted
      ? "执行已取消"
      : result.outputLimitExceeded
        ? "输出超过限制"
        : `退出码 ${result.exitCode ?? "unknown"}`;
  const diagnostic = result.stderr.trim().slice(-4_000);
  throw new MediaProcessError(`${label}${reason}${diagnostic ? `: ${diagnostic}` : ""}`, result);
}

export async function runFfmpeg(
  args: string[],
  options: MediaBinaryOptions & { cwd?: string } = {},
): Promise<ControlledProcessResult> {
  const executable = resolvedMediaBinaries(options).ffmpeg;
  const result = await runControlledProcess({
    executable,
    args: ["-nostdin", "-hide_banner", ...args],
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    maxOutputBytes: options.maxOutputBytes ?? 8 * 1024 * 1024,
    signal: options.signal,
  });
  return assertSuccessful(result, "FFmpeg ");
}

export type ProbeResult = {
  format?: Record<string, unknown>;
  streams?: Array<Record<string, unknown>>;
  chapters?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export async function probeMedia(
  filePath: string,
  options: MediaBinaryOptions = {},
): Promise<ProbeResult> {
  const absolutePath = resolve(filePath);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`媒体路径不是文件: ${absolutePath}`);
  const result = await runControlledProcess({
    executable: resolvedMediaBinaries(options).ffprobe,
    args: ["-v", "error", "-show_format", "-show_streams", "-show_chapters", "-of", "json", absolutePath],
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
    signal: options.signal,
  });
  assertSuccessful(result, "FFprobe ");
  try {
    return JSON.parse(result.stdout) as ProbeResult;
  } catch (error) {
    throw new MediaProcessError("FFprobe 返回了无效 JSON", result, { cause: error });
  }
}
