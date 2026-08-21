import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runOriginalAgentOpening,
  type OriginalAgentOpeningOptions,
} from "../src/main/original-agent-opening";
import type { ClaudeAgentRuntimeOptions, ClaudeAgentRuntimeResult } from "../src/main/claude-agent-runtime";
import type { JobEventLevel } from "../src/main/jobs";

const roots: string[] = [];

function generalDraft(count = 5): string {
  return [
    "【题材】都市重生",
    ...Array.from({ length: count }, (_, index) => [
      `—— 开头 ${index + 1}（冲突钩子） ——`,
      `这是第 ${index + 1} 个开头。`,
    ].join("\n")),
  ].join("\n\n");
}

async function fixture(): Promise<{ resourcesRoot: string; workRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "ai-tool-agent-opening-"));
  roots.push(root);
  const resourcesRoot = join(root, "vendor");
  const modeRoot = join(resourcesRoot, "opening-skill", "general");
  await mkdir(join(modeRoot, ".claude", "skills", "novel-optimizer"), { recursive: true });
  await writeFile(join(modeRoot, ".claude", "skills", "novel-optimizer", "SKILL.md"), "# test skill", "utf8");
  await writeFile(join(modeRoot, "CLAUDE.md"), "test instructions", "utf8");
  return { resourcesRoot, workRoot: join(root, "work") };
}

function context(signal: AbortSignal) {
  return {
    signal,
    updateProgress: vi.fn(),
    emit: vi.fn<(level: JobEventLevel, message: string, detail?: unknown) => void>(),
  };
}

function runtimeResult(index: number): ClaudeAgentRuntimeResult {
  return {
    result: "这段回复不能替代落盘产物",
    sessionId: `session-${index}`,
    model: `runtime-model-${index}`,
    eventCount: index + 2,
    exitCode: 0,
    stderr: "",
  };
}

async function baseOptions(): Promise<OriginalAgentOpeningOptions> {
  const paths = await fixture();
  return {
    ...paths,
    mode: "general",
    source: "\n第一章\n他在高考前重生了。\n",
    baseUrl: "https://api.example.com/v1",
    apiKey: "test-secret",
    model: "deepseek-v4-pro",
    context: context(new AbortController().signal),
  };
}

describe("original opening file Agent orchestration", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("copies the selected skill into an isolated workspace and trusts only output_kaitou.txt", async () => {
    const options = await baseOptions();
    const calls: ClaudeAgentRuntimeOptions[] = [];
    options.runAgent = async (runtimeOptions) => {
      calls.push(runtimeOptions);
      await writeFile(join(runtimeOptions.cwd, "output_kaitou.txt"), `\uFEFF${generalDraft()}\n`, "utf8");
      return runtimeResult(calls.length);
    };

    const result = await runOriginalAgentOpening(options);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      prompt: expect.stringContaining("/novel-optimizer"),
    });
    expect(calls[0]!.cwd).toBe(result.workDirectory);
    expect(result.workDirectory.startsWith(options.workRoot)).toBe(true);
    expect(await readFile(join(result.workDirectory, "原文.txt"), "utf8")).toBe(options.source);
    expect(await readFile(join(result.workDirectory, "CLAUDE.md"), "utf8")).toBe("test instructions");
    expect(await readFile(join(result.workDirectory, ".claude", "skills", "novel-optimizer", "SKILL.md"), "utf8"))
      .toBe("# test skill");
    expect(result.draft).toBe(generalDraft());
    expect(result.draft).not.toContain("这段回复不能替代落盘产物");
    expect(result).toMatchObject({
      outputPath: join(result.workDirectory, "output_kaitou.txt"),
      model: "runtime-model-1",
      attempts: 1,
      repairRounds: 0,
      runtime: [{ phase: "generate", repairRound: 0, sessionId: "session-1" }],
    });
  });

  it("starts a fresh Agent run for each targeted repair while keeping one workspace", async () => {
    const options = await baseOptions();
    const calls: ClaudeAgentRuntimeOptions[] = [];
    options.runAgent = async (runtimeOptions) => {
      calls.push(runtimeOptions);
      await writeFile(
        join(runtimeOptions.cwd, "output_kaitou.txt"),
        calls.length === 1 ? generalDraft(4) : generalDraft(),
        "utf8",
      );
      return runtimeResult(calls.length);
    };

    const result = await runOriginalAgentOpening(options);

    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.cwd)).size).toBe(1);
    expect(calls[1]!.prompt).toContain("必须恰好输出 5 个开头，当前识别到 4 个");
    expect(calls[1]!.prompt).toContain("output_kaitou.txt");
    expect(result).toMatchObject({ attempts: 2, repairRounds: 1, model: "runtime-model-2" });
    expect(result.runtime.map((run) => [run.phase, run.repairRound, run.sessionId])).toEqual([
      ["generate", 0, "session-1"],
      ["repair", 1, "session-2"],
    ]);
  });

  it("allows at most three repair sessions and reports the final file errors clearly", async () => {
    const options = await baseOptions();
    const prompts: string[] = [];
    options.runAgent = async (runtimeOptions) => {
      prompts.push(runtimeOptions.prompt);
      await writeFile(join(runtimeOptions.cwd, "output_kaitou.txt"), "不合格", "utf8");
      return runtimeResult(prompts.length);
    };

    await expect(runOriginalAgentOpening(options)).rejects.toThrow(
      /在 3 轮定向修复后仍未通过硬校验：.*必须恰好输出 5 个开头.*output_kaitou\.txt/u,
    );
    expect(prompts).toHaveLength(4);
    expect(prompts.slice(1).every((prompt) => prompt.includes("缺少【题材】标记"))).toBe(true);
  });

  it("does not use Agent result text when output_kaitou.txt is missing", async () => {
    const options = await baseOptions();
    options.maxRepairRounds = 0;
    options.runAgent = async () => runtimeResult(1);

    await expect(runOriginalAgentOpening(options)).rejects.toThrow("未生成 output_kaitou.txt");
  });

  it("propagates an abort reason without wrapping it", async () => {
    const options = await baseOptions();
    const controller = new AbortController();
    const stop = new Error("用户停止开头任务");
    options.context = context(controller.signal);
    options.runAgent = async (runtimeOptions) => {
      controller.abort(stop);
      throw runtimeOptions.context.signal.reason;
    };

    await expect(runOriginalAgentOpening(options)).rejects.toBe(stop);
  });
});
