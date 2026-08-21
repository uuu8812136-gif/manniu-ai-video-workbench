import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { delimiter, dirname, resolve } from "node:path";
import type { JobExecutionContext } from "./jobs";

const DEFAULT_PROXY_READY_TIMEOUT_MS = 15_000;
const DEFAULT_TOOLS = "Skill,Read,Write,Edit,Bash,PowerShell,Glob,Grep";
const STDERR_TAIL_LIMIT = 64 * 1024;

export type ClaudeAgentContext = Pick<JobExecutionContext, "signal" | "updateProgress" | "emit">;

export type ClaudeAgentChildProcess = ChildProcessWithoutNullStreams;

export type ClaudeAgentSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ClaudeAgentChildProcess;

export type ClaudeAgentExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type ClaudeAgentStreamEvent = Record<string, unknown> & {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  session_id?: string;
};

export type ClaudeAgentRuntimeResult = {
  result: string;
  sessionId: string | null;
  model: string | null;
  eventCount: number;
  exitCode: number;
  stderr: string;
};

export type ClaudeAgentRuntimeOptions = {
  claudePath: string;
  pythonPath: string;
  proxyPath: string;
  cwd: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  context: ClaudeAgentContext;
  configDir?: string;
  progressStart?: number;
  progressEnd?: number;
  proxyReadyTimeoutMs?: number;
  tools?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: ClaudeAgentSpawn;
  allocatePort?: () => Promise<number>;
  waitForPort?: (port: number, signal: AbortSignal, timeoutMs: number) => Promise<void>;
  killProcessTree?: (child: ClaudeAgentChildProcess) => Promise<void>;
  onEvent?: (event: ClaudeAgentStreamEvent) => void;
};

type ParsedStreamState = {
  result: string | null;
  sessionId: string | null;
  model: string | null;
  eventCount: number;
  terminalError: string | null;
  terminalSeen: boolean;
  assistantText: string[];
  lastToolError: string | null;
};

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  return normalized;
}

function appendTail(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= STDERR_TAIL_LIMIT ? combined : combined.slice(-STDERR_TAIL_LIMIT);
}

function redactSecret(value: string, secret: string): string {
  let redacted = value;
  for (const candidate of [secret, secret.length >= 8 ? secret.slice(0, 8) : ""]) {
    if (!candidate) continue;
    redacted = redacted.split(candidate).join("[REDACTED]");
  }
  return redacted;
}

function aborted(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Claude Agent 任务已停止");
  error.name = "AbortError";
  return error;
}

function isRunning(child: ClaudeAgentChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(child: ClaudeAgentChildProcess): Promise<ClaudeAgentExit> {
  if (!isRunning(child)) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配本地 Claude 代理端口"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal.aborted) {
      reject(aborted(signal));
      return;
    }
    const finish = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(aborted(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise<boolean>((resolveConnection) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveConnection(connected);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForLoopbackPort(port: number, signal: AbortSignal, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw aborted(signal);
    if (await canConnect(port)) return;
    await delay(50, signal);
  }
  throw new Error(`Claude 协议代理启动超时（${timeoutMs}ms）`);
}

async function defaultKillProcessTree(child: ClaudeAgentChildProcess): Promise<void> {
  if (!isRunning(child)) return;
  if (process.platform !== "win32" || !child.pid) {
    child.kill("SIGKILL");
    return;
  }
  await new Promise<void>((resolveKill) => {
    const killer = nodeSpawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => {
      child.kill("SIGKILL");
      resolveKill();
    });
    killer.once("close", () => resolveKill());
  });
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted(signal));
  return new Promise<T>((resolveResult, reject) => {
    const onAbort = (): void => {
      reject(aborted(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolveResult(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function contentBlocks(event: ClaudeAgentStreamEvent): Array<Record<string, unknown>> {
  const message = event.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content)
    ? content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
    : [];
}

function blockText(block: Record<string, unknown>): string {
  if (typeof block.content === "string") return block.content.trim();
  if (!Array.isArray(block.content)) return "";
  return block.content
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => typeof item.text === "string" ? item.text.trim() : "")
    .filter(Boolean)
    .join("\n");
}

function latestAssistantError(texts: readonly string[]): string | null {
  return [...texts]
    .reverse()
    .map((text) => text.trim())
    .find((text) => /(?:api error|error|失败|异常|余额|额度|rate.?limit|timed?.?out)/iu.test(text))
    ?.slice(-4_000) ?? null;
}

function eventMessage(event: ClaudeAgentStreamEvent): { message: string; detail?: unknown } | null {
  if (event.type === "system") {
    return { message: event.subtype === "init" ? "Claude Agent 引擎就绪" : "Claude Agent 正在初始化" };
  }
  for (const block of contentBlocks(event)) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      return { message: `正在执行 ${block.name}`, detail: { tool: block.name } };
    }
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      return { message: "Claude Agent 正在分析任务", detail: { receivedCharacters: block.text.length } };
    }
  }
  if (event.type === "user") return { message: "Claude Agent 工具执行完成" };
  if (event.type === "result") return { message: "Claude Agent 本轮执行结束" };
  return null;
}

function updateState(event: ClaudeAgentStreamEvent, state: ParsedStreamState): void {
  state.eventCount += 1;
  if (typeof event.session_id === "string") state.sessionId = event.session_id;
  if (typeof event.model === "string") state.model = event.model;
  for (const block of contentBlocks(event)) {
    if (block.type === "text" && typeof block.text === "string") state.assistantText.push(block.text);
    if (block.type === "tool_result" && block.is_error === true) {
      state.lastToolError = blockText(block) || "Claude Agent 工具执行失败";
    }
  }
  if (event.type !== "result") return;
  state.terminalSeen = true;
  if (typeof event.result === "string") state.result = event.result;
  else if (event.result !== undefined) state.result = JSON.stringify(event.result);
  if (event.is_error || (typeof event.subtype === "string" && event.subtype !== "success")) {
    state.terminalError = state.result || `Claude Agent 返回失败终态：${event.subtype ?? "unknown"}`;
  }
}

function createStreamConsumer(options: {
  child: ClaudeAgentChildProcess;
  context: ClaudeAgentContext;
  progressStart: number;
  progressEnd: number;
  killProcessTree: (child: ClaudeAgentChildProcess) => Promise<void>;
  onEvent?: (event: ClaudeAgentStreamEvent) => void;
}): Promise<ClaudeAgentRuntimeResult> {
  const { child, context, progressStart, progressEnd, killProcessTree, onEvent } = options;
  const state: ParsedStreamState = {
    result: null,
    sessionId: null,
    model: null,
    eventCount: 0,
    terminalError: null,
    terminalSeen: false,
    assistantText: [],
    lastToolError: null,
  };
  let buffer = "";
  let stderr = "";
  let progress = progressStart;

  return new Promise<ClaudeAgentRuntimeResult>((resolveResult, reject) => {
    let settled = false;
    const cleanup = (): void => {
      context.signal.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void killProcessTree(child).finally(() => reject(error));
    };
    const handleLine = (rawLine: string): void => {
      const line = rawLine.trim();
      if (!line) return;
      let event: ClaudeAgentStreamEvent;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        event = parsed as ClaudeAgentStreamEvent;
      } catch {
        context.emit("warning", "Claude Agent 输出了无法解析的事件", { preview: line.slice(0, 240) });
        return;
      }
      updateState(event, state);
      onEvent?.(event);
      const status = eventMessage(event);
      if (status) {
        const span = Math.max(1, progressEnd - progressStart);
        const next = event.type === "result"
          ? progressEnd
          : Math.min(progressEnd - 1, Math.max(progress + 1, progressStart + Math.floor(span * 0.08)));
        progress = Math.max(progress, next);
        context.updateProgress(progress, status.message, status.detail);
      }
    };
    const drain = (): void => {
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    };
    const onAbort = (): void => rejectOnce(aborted(context.signal));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      drain();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendTail(stderr, chunk);
    });
    child.once("error", rejectOnce);
    child.once("close", (code, signal) => {
      if (settled) return;
      if (buffer.trim()) handleLine(buffer);
      settled = true;
      cleanup();
      if (context.signal.aborted) {
        reject(aborted(context.signal));
        return;
      }
      if (code !== 0) {
        const cause = state.terminalError
          || latestAssistantError(state.assistantText)
          || state.lastToolError
          || stderr.trim().slice(-4_000);
        context.emit("warning", "Claude Agent 进程异常退出", {
          code,
          signal: signal ?? "none",
          eventCount: state.eventCount,
          terminalSeen: state.terminalSeen,
        });
        reject(new Error(
          `Claude Agent 异常退出（code=${code ?? "null"}, signal=${signal ?? "none"}）`
          + `${cause ? `\n${cause}` : "\n模型服务中断或 Claude Agent 未返回完整终态，请重试任务。"}`,
        ));
        return;
      }
      if (state.terminalError) {
        reject(new Error(state.terminalError));
        return;
      }
      if (!state.terminalSeen) {
        reject(new Error("Claude Agent 已退出，但没有返回 result 终态"));
        return;
      }
      const result = state.result ?? state.assistantText.join("\n").trim();
      resolveResult({
        result,
        sessionId: state.sessionId,
        model: state.model,
        eventCount: state.eventCount,
        exitCode: code,
        stderr,
      });
    });
    context.signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runClaudeAgent(options: ClaudeAgentRuntimeOptions): Promise<ClaudeAgentRuntimeResult> {
  const claudePath = required(options.claudePath, "Claude 可执行文件路径");
  const pythonPath = required(options.pythonPath, "Python 可执行文件路径");
  const proxyPath = required(options.proxyPath, "Claude 协议代理路径");
  const cwd = resolve(required(options.cwd, "Claude 工作目录"));
  const baseUrl = required(options.baseUrl, "模型 API 地址").replace(/\/+$/u, "");
  const apiKey = required(options.apiKey, "模型 API Key");
  const model = required(options.model, "模型名称");
  const prompt = required(options.prompt, "Claude Agent 提示词");
  const configDir = resolve(options.configDir ?? resolve(cwd, ".claude-agent-config"));
  const progressStart = options.progressStart ?? 10;
  const progressEnd = options.progressEnd ?? 90;
  const proxyReadyTimeoutMs = options.proxyReadyTimeoutMs ?? DEFAULT_PROXY_READY_TIMEOUT_MS;
  const spawnProcess = options.spawnProcess ?? (nodeSpawn as ClaudeAgentSpawn);
  const allocatePort = options.allocatePort ?? allocateLoopbackPort;
  const waitForPort = options.waitForPort ?? waitForLoopbackPort;
  const killProcessTree = options.killProcessTree ?? defaultKillProcessTree;

  if (progressStart < 0 || progressEnd > 100 || progressEnd <= progressStart) {
    throw new RangeError("Claude Agent 进度区间无效");
  }
  if (!Number.isFinite(proxyReadyTimeoutMs) || proxyReadyTimeoutMs <= 0) {
    throw new RangeError("Claude Agent proxyReadyTimeoutMs 必须大于 0");
  }
  if (options.context.signal.aborted) throw aborted(options.context.signal);

  await mkdir(configDir, { recursive: true });
  const port = await allocatePort();
  const baseEnv = { ...process.env, ...options.env };
  const proxy = spawnProcess(pythonPath, [proxyPath, String(port)], {
    cwd,
    windowsHide: true,
    shell: false,
    env: {
      ...baseEnv,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      DEEPSEEK_API_KEY: apiKey,
      DEEPSEEK_MODEL: model,
      UPSTREAM_BASE: baseUrl,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proxy.stdin.on("error", () => {});
  proxy.stdin.end();
  proxy.stdout.resume();
  let proxyStderr = "";
  proxy.stderr.setEncoding("utf8");
  proxy.stderr.on("data", (chunk: string) => {
    proxyStderr = appendTail(proxyStderr, chunk);
  });
  const proxyExit = waitForExit(proxy);
  options.context.updateProgress(progressStart, "正在启动 Claude 协议代理");

  let claude: ClaudeAgentChildProcess | null = null;
  try {
    const ready = await raceWithAbort(Promise.race([
      waitForPort(port, options.context.signal, proxyReadyTimeoutMs).then(() => ({ type: "ready" as const })),
      proxyExit.then((exit) => ({ type: "exit" as const, exit })),
    ]), options.context.signal);
    if (ready.type === "exit") {
      throw new Error(
        `Claude 协议代理启动失败（code=${ready.exit.code ?? "null"}, signal=${ready.exit.signal ?? "none"}）`
        + `${proxyStderr.trim() ? `\n${redactSecret(proxyStderr.trim(), apiKey)}` : ""}`,
      );
    }

    const endpoint = `http://127.0.0.1:${port}`;
    const settings = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: endpoint,
        ANTHROPIC_AUTH_TOKEN: "sk-placeholder",
      },
    });
    const claudeArgs = [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      options.tools ?? DEFAULT_TOOLS,
      "--settings",
      settings,
      "--add-dir",
      cwd,
    ];
    const inheritedPath = baseEnv.PATH ?? baseEnv.Path ?? baseEnv.path ?? "";
    const claudeEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      DISABLE_PROMPT_CACHING: "1",
      PATH: [dirname(pythonPath), inheritedPath].filter(Boolean).join(delimiter),
    };
    for (const key of Object.keys(claudeEnv)) {
      if (key !== "PATH" && key.toLowerCase() === "path") delete claudeEnv[key];
    }
    claude = spawnProcess(claudePath, claudeArgs, {
      cwd,
      windowsHide: true,
      shell: false,
      env: claudeEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    claude.stdin.on("error", (error) => {
      options.context.emit("warning", "Claude Agent stdin 已提前关闭", { error: String(error) });
    });
    options.context.emit("info", "Claude Agent 已启动", { port, pid: claude.pid ?? null });
    const claudeRun = createStreamConsumer({
      child: claude,
      context: options.context,
      progressStart: Math.min(progressEnd - 1, progressStart + 1),
      progressEnd,
      killProcessTree,
      onEvent: options.onEvent,
    });
    claude.stdin.end(prompt, "utf8");

    const outcome = await Promise.race([
      claudeRun.then(
        (result) => ({ type: "result" as const, result }),
        (error: unknown) => ({ type: "error" as const, error }),
      ),
      proxyExit.then((exit) => ({ type: "proxy-exit" as const, exit })),
    ]);
    if (outcome.type === "result") return outcome.result;
    if (outcome.type === "error") throw outcome.error;
    await killProcessTree(claude);
    throw new Error(
      `Claude 协议代理在任务执行期间退出（code=${outcome.exit.code ?? "null"}, signal=${outcome.exit.signal ?? "none"}）`
      + `${proxyStderr.trim() ? `\n${redactSecret(proxyStderr.trim(), apiKey)}` : ""}`,
    );
  } finally {
    if (claude && options.context.signal.aborted && isRunning(claude)) await killProcessTree(claude);
    if (isRunning(proxy)) await killProcessTree(proxy);
  }
}
