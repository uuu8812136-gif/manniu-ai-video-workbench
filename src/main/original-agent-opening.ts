import { access, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  runClaudeAgent,
  type ClaudeAgentContext,
  type ClaudeAgentRuntimeOptions,
  type ClaudeAgentRuntimeResult,
} from "./claude-agent-runtime";
import { validateOriginalOpeningDraft, type OriginalOpeningMode } from "./opening-runtime";
import { originalOpeningAgentPrompt, originalOpeningRepairPrompt } from "./original-agent-prompts";

const MAX_REPAIR_ROUNDS = 3;

export type OriginalAgentOpeningRun = Pick<
  ClaudeAgentRuntimeResult,
  "sessionId" | "model" | "eventCount" | "exitCode"
> & {
  phase: "generate" | "repair";
  repairRound: number;
};

export type OriginalAgentOpeningResult = {
  draft: string;
  outputPath: string;
  workDirectory: string;
  model: string;
  attempts: number;
  repairRounds: number;
  runtime: OriginalAgentOpeningRun[];
};

export type OriginalAgentOpeningOptions = {
  mode: OriginalOpeningMode;
  source: string;
  resourcesRoot: string;
  workRoot: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  context: ClaudeAgentContext;
  claudePath?: string;
  pythonPath?: string;
  proxyPath?: string;
  maxRepairRounds?: number;
  runAgent?: (options: ClaudeAgentRuntimeOptions) => Promise<ClaudeAgentRuntimeResult>;
};

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  return normalized;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("开头 Agent 任务已停止");
  error.name = "AbortError";
  throw error;
}

function repairLimit(value: number | undefined): number {
  const result = value ?? MAX_REPAIR_ROUNDS;
  if (!Number.isInteger(result) || result < 0 || result > MAX_REPAIR_ROUNDS) {
    throw new RangeError(`maxRepairRounds 必须是 0 到 ${MAX_REPAIR_ROUNDS} 的整数`);
  }
  return result;
}

async function copyDirectoryContents(source: string, destination: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(entries.map((entry) => cp(
    join(source, entry.name),
    join(destination, entry.name),
    { recursive: entry.isDirectory(), errorOnExist: true, force: false },
  )));
}

async function readAndValidateDraft(
  outputPath: string,
  mode: OriginalOpeningMode,
  source: string,
  signal: AbortSignal,
): Promise<{ draft: string; errors: string[] }> {
  throwIfAborted(signal);
  let raw: string;
  try {
    raw = await readFile(outputPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { draft: "", errors: ["未生成 output_kaitou.txt"] };
  }
  throwIfAborted(signal);
  const draft = raw.replace(/^\uFEFF/u, "").trim();
  if (!draft) return { draft, errors: ["output_kaitou.txt 为空"] };
  return { draft, errors: validateOriginalOpeningDraft(draft, mode, source) };
}

function runtimeSummary(
  result: ClaudeAgentRuntimeResult,
  phase: "generate" | "repair",
  repairRound: number,
): OriginalAgentOpeningRun {
  return {
    phase,
    repairRound,
    sessionId: result.sessionId,
    model: result.model,
    eventCount: result.eventCount,
    exitCode: result.exitCode,
  };
}

function progressRange(runIndex: number): { progressStart: number; progressEnd: number } {
  if (runIndex === 0) return { progressStart: 8, progressEnd: 68 };
  const progressStart = 68 + ((runIndex - 1) * 8);
  return { progressStart, progressEnd: progressStart + 8 };
}

export async function runOriginalAgentOpening(
  options: OriginalAgentOpeningOptions,
): Promise<OriginalAgentOpeningResult> {
  required(options.source, "原文");
  const source = options.source;
  const resourcesRoot = resolve(required(options.resourcesRoot, "资源目录"));
  const workRoot = resolve(required(options.workRoot, "开头工作目录根路径"));
  const baseUrl = required(options.baseUrl, "模型 API 地址");
  const apiKey = required(options.apiKey, "模型 API Key");
  const configuredModel = required(options.model, "模型名称");
  const maxRepairRounds = repairLimit(options.maxRepairRounds);
  const runAgent = options.runAgent ?? runClaudeAgent;
  const signal = options.context.signal;

  throwIfAborted(signal);
  await mkdir(workRoot, { recursive: true });
  const workDirectory = await mkdtemp(join(workRoot, `opening-${options.mode}-`));
  const skillSource = join(resourcesRoot, "opening-skill", options.mode);
  await copyDirectoryContents(skillSource, workDirectory);
  throwIfAborted(signal);

  const skillPath = join(workDirectory, ".claude", "skills", "novel-optimizer", "SKILL.md");
  await access(skillPath);
  const sourcePath = join(workDirectory, "原文.txt");
  const outputPath = join(workDirectory, "output_kaitou.txt");
  await writeFile(sourcePath, source, "utf8");
  throwIfAborted(signal);

  const runtimeRoot = {
    claudePath: resolve(options.claudePath ?? join(resourcesRoot, "claude", "bin", "claude.exe")),
    pythonPath: resolve(options.pythonPath ?? join(resourcesRoot, "python", "python.exe")),
    proxyPath: resolve(options.proxyPath ?? join(resourcesRoot, "inference-skill", "claude_openai_proxy.py")),
  };
  const runtime: OriginalAgentOpeningRun[] = [];

  const execute = async (prompt: string, repairRound: number): Promise<void> => {
    throwIfAborted(signal);
    const range = progressRange(runtime.length);
    const result = await runAgent({
      ...runtimeRoot,
      cwd: workDirectory,
      configDir: join(workDirectory, ".claude-agent-config"),
      baseUrl,
      apiKey,
      model: configuredModel,
      prompt,
      context: options.context,
      progressStart: range.progressStart,
      progressEnd: range.progressEnd,
    });
    throwIfAborted(signal);
    runtime.push(runtimeSummary(result, repairRound === 0 ? "generate" : "repair", repairRound));
  };

  await execute(originalOpeningAgentPrompt(options.mode), 0);
  let validation = await readAndValidateDraft(outputPath, options.mode, source, signal);
  let repairRound = 0;
  while (validation.errors.length > 0 && repairRound < maxRepairRounds) {
    repairRound += 1;
    options.context.emit("warning", "开头 Agent 产物未通过硬校验，正在定向修复", {
      repairRound,
      errors: validation.errors,
      outputPath,
    });
    await execute(originalOpeningRepairPrompt(options.mode, validation.errors), repairRound);
    validation = await readAndValidateDraft(outputPath, options.mode, source, signal);
  }

  if (validation.errors.length > 0) {
    throw new Error(
      `开头 Agent 产物在 ${repairRound} 轮定向修复后仍未通过硬校验：${validation.errors.join("；")}（产物：${outputPath}）`,
    );
  }

  options.context.updateProgress(94, "开头 Agent 产物已通过硬校验", { outputPath, repairRounds: repairRound });
  const runtimeModel = [...runtime].reverse().find((run) => run.model)?.model ?? configuredModel;
  return {
    draft: validation.draft,
    outputPath,
    workDirectory,
    model: runtimeModel,
    attempts: runtime.length,
    repairRounds: repairRound,
    runtime,
  };
}
