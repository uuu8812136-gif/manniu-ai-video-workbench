import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runClaudeAgent,
  type ClaudeAgentChildProcess,
  type ClaudeAgentSpawn,
} from "../src/main/claude-agent-runtime";
import type { JobEventLevel } from "../src/main/jobs";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdio = [this.stdin, this.stdout, this.stderr, null, null] as const;
  readonly connected = false;
  readonly killed = false;
  readonly spawnfile = "fake";
  readonly spawnargs: string[] = [];
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    return true;
  }

  ref(): void {}
  unref(): void {}
  disconnect(): void {}
  send(): boolean { return false; }

  close(code = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

type SpawnCall = { command: string; args: readonly string[]; options: SpawnOptions; child: FakeChild };

function fakeSpawner(onClaude?: (child: FakeChild) => void): { spawn: ClaudeAgentSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: ClaudeAgentSpawn = (command, args, options) => {
    const child = new FakeChild(1000 + calls.length);
    calls.push({ command, args, options, child });
    if (calls.length === 2) onClaude?.(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawn, calls };
}

function context(signal: AbortSignal) {
  return {
    signal,
    updateProgress: vi.fn(),
    emit: vi.fn<(level: JobEventLevel, message: string, detail?: unknown) => void>(),
  };
}

function baseOptions(signal: AbortSignal) {
  return {
    claudePath: "C:\\runtime\\claude.exe",
    pythonPath: "C:\\runtime\\python.exe",
    proxyPath: "C:\\runtime\\claude_deepseek_proxy.py",
    cwd: "C:\\tasks\\storyboard-1",
    configDir: tmpdir(),
    baseUrl: "https://api.example.com/",
    apiKey: "secret-key",
    model: "deepseek-v4-pro",
    prompt: "/ai-tool-fenjing\n执行分镜任务",
    context: context(signal),
    allocatePort: async () => 15798,
    waitForPort: async () => {},
  };
}

describe("Claude Agent runtime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the original proxy and Claude command, writes stdin, and parses stream-json", async () => {
    let stdin = "";
    const { spawn, calls } = fakeSpawner((child) => {
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (chunk: string) => { stdin += chunk; });
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" })}\n`);
        const toolEvent = JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "novel.txt" } }] },
        });
        child.stdout.write(toolEvent.slice(0, 20));
        child.stdout.write(`${toolEvent.slice(20)}\n`);
        child.stdout.write(`${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "任务完成",
          session_id: "session-1",
          model: "claude-sonnet-4-6",
        })}\n`);
        child.close();
      });
    });
    const killed: number[] = [];
    const options = baseOptions(new AbortController().signal);

    const result = await runClaudeAgent({
      ...options,
      spawnProcess: spawn,
      killProcessTree: async (child) => { killed.push(child.pid!); },
    });

    expect(result).toMatchObject({
      result: "任务完成",
      sessionId: "session-1",
      model: "claude-sonnet-4-6",
      eventCount: 3,
      exitCode: 0,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe(options.pythonPath);
    expect(calls[0].args).toEqual([options.proxyPath, "15798"]);
    expect(calls[0].options).toMatchObject({ cwd: options.cwd, windowsHide: true });
    expect(calls[0].options.env).toMatchObject({
      UPSTREAM_BASE: "https://api.example.com",
      DEEPSEEK_API_KEY: "secret-key",
      DEEPSEEK_MODEL: "deepseek-v4-pro",
    });

    expect(calls[1].command).toBe(options.claudePath);
    expect(calls[1].args).toEqual([
      "-p",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      "Skill,Read,Write,Edit,Bash,PowerShell,Glob,Grep",
      "--settings",
      JSON.stringify({ env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:15798",
        ANTHROPIC_AUTH_TOKEN: "sk-placeholder",
      } }),
      "--add-dir",
      options.cwd,
    ]);
    expect(calls[1].options).toMatchObject({ cwd: options.cwd, windowsHide: true });
    expect(calls[1].options.env).toMatchObject({
      CLAUDE_CONFIG_DIR: options.configDir,
      DISABLE_PROMPT_CACHING: "1",
    });
    expect(stdin).toBe(options.prompt);
    expect(options.context.updateProgress).toHaveBeenCalledWith(
      expect.any(Number),
      "正在执行 Read",
      { tool: "Read" },
    );
    expect(killed).toEqual([1000]);
  });

  it("terminates both process trees when the job is aborted", async () => {
    const controller = new AbortController();
    const { spawn, calls } = fakeSpawner();
    const killed: number[] = [];
    const stop = new Error("用户停止任务");
    const promise = runClaudeAgent({
      ...baseOptions(controller.signal),
      spawnProcess: spawn,
      killProcessTree: async (child) => {
        killed.push(child.pid!);
        (child as unknown as FakeChild).close(null as unknown as number, "SIGKILL");
      },
    });

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    controller.abort(stop);

    await expect(promise).rejects.toBe(stop);
    expect(killed).toEqual(expect.arrayContaining([1000, 1001]));
  });

  it("keeps a silent long-running agent alive until the user stops it", async () => {
    vi.useFakeTimers();
    let signalSpawned!: () => void;
    const spawned = new Promise<void>((resolveSpawned) => { signalSpawned = resolveSpawned; });
    const { spawn } = fakeSpawner(() => signalSpawned());
    const killed: number[] = [];
    const controller = new AbortController();
    const stop = new Error("用户停止长任务");
    const promise = runClaudeAgent({
      ...baseOptions(controller.signal),
      spawnProcess: spawn,
      killProcessTree: async (child) => {
        killed.push(child.pid!);
        (child as unknown as FakeChild).close(null as unknown as number, "SIGKILL");
      },
    });
    const rejection = promise.catch((error: unknown) => error);

    await spawned;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(killed).toEqual([]);
    controller.abort(stop);

    await expect(rejection).resolves.toBe(stop);
    expect(killed).toEqual(expect.arrayContaining([1000, 1001]));
  });

  it("does not accept assistant text without a result terminal", async () => {
    const { spawn } = fakeSpawner((child) => {
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "看起来完成了" }] },
        })}\n`);
        child.close();
      });
    });

    await expect(runClaudeAgent({
      ...baseOptions(new AbortController().signal),
      spawnProcess: spawn,
      killProcessTree: async () => {},
    })).rejects.toThrow("没有返回 result 终态");
  });

  it("rejects a failed Claude result terminal without exposing the API key", async () => {
    const { spawn } = fakeSpawner((child) => {
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "工具执行失败",
        })}\n`);
        child.close();
      });
    });
    const options = baseOptions(new AbortController().signal);

    await expect(runClaudeAgent({
      ...options,
      spawnProcess: spawn,
      killProcessTree: async () => {},
    })).rejects.toThrow("工具执行失败");
  });

  it("shows the terminal API error instead of dumping stream-json after a non-zero exit", async () => {
    const { spawn } = fakeSpawner((child) => {
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "customer-session",
          tools: Array.from({ length: 200 }, (_, index) => `tool-${index}`),
        })}\n`);
        child.stdout.write(`${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          result: "API Error: Insufficient Balance",
        })}\n`);
        child.close(1);
      });
    });

    const reason = await runClaudeAgent({
      ...baseOptions(new AbortController().signal),
      spawnProcess: spawn,
      killProcessTree: async () => {},
    }).then(() => null, (error: unknown) => error);

    expect(reason).toBeInstanceOf(Error);
    const message = reason instanceof Error ? reason.message : String(reason);
    expect(message).toContain("API Error: Insufficient Balance");
    expect(message).not.toContain("customer-session");
    expect(message).not.toContain("tool-199");
  });

  it("shows the last failed edit when Claude exits without a result terminal", async () => {
    const { spawn } = fakeSpawner((child) => {
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              is_error: true,
              content: "String to replace not found in file. The file was modified by an earlier Edit.",
            }],
          },
        })}\n`);
        child.close(1);
      });
    });

    await expect(runClaudeAgent({
      ...baseOptions(new AbortController().signal),
      spawnProcess: spawn,
      killProcessTree: async () => {},
    })).rejects.toThrow("String to replace not found in file");
  });
});
