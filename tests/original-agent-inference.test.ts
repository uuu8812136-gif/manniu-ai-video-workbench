import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCsvFile, writeCsvFileAtomic } from "../src/main/file-workflows";
import { inferenceRuntimePaths } from "../src/main/inference-runtime";
import {
  runOriginalAgentInference,
  type OriginalAgentCall,
  type OriginalInferenceScriptCall,
} from "../src/main/original-agent-inference";
import type { ClaudeAgentRuntimeResult } from "../src/main/claude-agent-runtime";
import { PauseJobError, type JobEventLevel, type JobExecutionContext } from "../src/main/jobs";

const VALID_CHARACTER_PROMPT = [
  "一张16:9比例的宽幅图像，画面包含该角色的设定集排版，严格遵循绝对的物理隔离排版规则：",
  "【左侧三分之一区域】：超大面部特写；",
  "【右侧三分之二区域】：依次排列全身正视图、全身侧视图、全身后视图。",
  "青年女性，清秀面容，黑色高马尾，白色劲装，",
  "100%纯正的顶级3D国漫风格，顶级3D国漫渲染风格，虚幻引擎5渲染，辛烷渲染，高级材质质感，",
  "绝对标准的人体比例严禁大头娃娃，双眼平视镜头，绝对无表情，不准笑，双臂自然下垂，",
  "纯白干净的背景，绝对没有任何环境杂物，绝对禁止2D动漫、绝对禁止赛璐璐、绝对禁止真人摄影、绝对禁止低模。",
].join("，");

const VALID_ROSTER = [
  "江青璃",
  "宗门弟子 | 女性 | 青年",
  VALID_CHARACTER_PROMPT,
].join("\n");

const COLUMNS = ["编号", "原声", "秒数", "画面提示词"];

function agentResult(model = "mock-agent-model"): ClaudeAgentRuntimeResult {
  return { result: "done", sessionId: "mock-session", model, eventCount: 3, exitCode: 0, stderr: "" };
}

function context(signal = new AbortController().signal): JobExecutionContext {
  return {
    jobId: "original-agent-inference-test",
    signal,
    updateProgress: vi.fn(),
    emit: vi.fn<(level: JobEventLevel, message: string, detail?: unknown) => void>(),
    complete: vi.fn(),
  };
}

function rows(count: number): Array<Record<string, string>> {
  return Array.from({ length: count }, (_, offset) => ({
    编号: String(offset + 1),
    原声: `江青璃第${offset + 1}次缓缓抬起右手凝视前方。`,
    秒数: "4",
    画面提示词: "",
  }));
}

function prompt(index: number, reviewed = false): string {
  return `@江青璃 第${index}次缓缓${reviewed ? "放下" : "抬起"}右手凝视前方，小动态，固定镜头，中景`;
}

function batchIndexes(value: string): number[] | null {
  const match = value.match(/唯一允许填写的镜号：([\d、]+)/u);
  return match ? match[1].split("、").map(Number) : null;
}

function repairIndexes(value: string): number[] | null {
  const match = value.match(/当前D列批次镜号为 ([\d,]+)/u);
  return match ? match[1].split(",").map(Number) : null;
}

async function patchRows(csvPath: string, indexes: number[], value: (index: number) => string): Promise<void> {
  const parsed = await readCsvFile(csvPath);
  const selected = new Set(indexes);
  for (const row of parsed.rows) {
    const index = Number(row["编号"]);
    if (selected.has(index)) row["画面提示词"] = value(index);
  }
  await writeCsvFileAtomic(csvPath, parsed.rows, { columns: COLUMNS, bom: true });
}

function reportPath(args: string[]): string | null {
  return args.find((arg) => arg.startsWith("--json-report="))?.slice("--json-report=".length) ?? null;
}

async function writeReport(path: string | null, badRows: number[]): Promise<void> {
  if (!path) return;
  await writeFile(path, JSON.stringify({
    error_count: badRows.length,
    issues: badRows.map((row) => ({
      code: "DCOL.TEST",
      target: "d_col",
      row,
      row_end: row,
      reason: "测试坏提示词",
      strategy: "重写整格D列",
      fixable: true,
    })),
  }), "utf8");
}

describe("original file-agent inference orchestration", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  });

  it("runs dynamic batches, targeted repair, protected-file restore and final parsing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-tool-agent-inference-"));
    temporaryDirectories.push(directory);
    const title = "动态批次";
    const csvPath = join(directory, `${title}.csv`);
    const rosterPath = join(directory, "角色表.txt");
    const batchCalls: number[][] = [];
    const repairCalls: number[][] = [];
    let poisoned = false;

    const runAgent: OriginalAgentCall = async (request) => {
      if (request.prompt.includes("禁止填写D列") && request.prompt.includes("/ai-tool-fenjing")) {
        await writeFile(rosterPath, VALID_ROSTER, "utf8");
        await writeCsvFileAtomic(csvPath, rows(61), { columns: COLUMNS, bom: true });
        await Promise.all([
          writeFile(join(directory, `${title}_arc.txt`), "视觉弧线", "utf8"),
          writeFile(join(directory, `${title}_marked.txt`), "标记原文", "utf8"),
          writeFile(join(directory, `${title}_sentences.txt`), "分句原文", "utf8"),
        ]);
        return agentResult();
      }
      const batch = batchIndexes(request.prompt);
      if (batch) {
        batchCalls.push(batch);
        await patchRows(csvPath, batch, (index) => {
          if (batch[0] === 11 && index === 11 && !poisoned) return "坏提示";
          return prompt(index);
        });
        if (batch[0] === 11 && !poisoned) poisoned = true;
        const parsed = await readCsvFile(csvPath);
        parsed.rows[0]["原声"] = "Agent越权篡改B列";
        const outside = parsed.rows.find((row) => Number(row["编号"]) === (batch.at(-1) ?? 0) + 1);
        if (outside) outside["画面提示词"] = "Agent越权填写批次外D列";
        await writeCsvFileAtomic(csvPath, parsed.rows, { columns: COLUMNS, bom: true });
        await writeFile(rosterPath, "Agent越权篡改角色表", "utf8");
        return agentResult();
      }
      const repair = repairIndexes(request.prompt);
      if (repair) {
        repairCalls.push(repair);
        await patchRows(csvPath, repair, (index) => prompt(index));
        return agentResult();
      }
      if (request.prompt.includes("全表语义复核")) {
        await patchRows(csvPath, [1], (index) => prompt(index, true));
        const parsed = await readCsvFile(csvPath);
        parsed.rows[0]["秒数"] = "99";
        await writeCsvFileAtomic(csvPath, parsed.rows, { columns: COLUMNS, bom: true });
        await writeFile(rosterPath, "审片越权篡改角色表", "utf8");
        return agentResult("semantic-agent-model");
      }
      throw new Error(`未识别测试 Agent Prompt：${request.prompt.slice(0, 80)}`);
    };

    const runScript: OriginalInferenceScriptCall = async (_runtime, script, args) => {
      if (script === "check_bcol.py") {
        const parsed = await readCsvFile(csvPath);
        const bad = parsed.rows.some((row, index) => row["原声"] !== rows(61)[index]["原声"] || row["秒数"] !== "4");
        await writeReport(reportPath(args), bad ? [1] : []);
        return { code: bad ? 1 : 0, stdout: bad ? "B列漂移" : "OK", stderr: "" };
      }
      if (args.includes("--roster-only")) {
        const valid = (await readFile(rosterPath, "utf8")).replace(/^\ufeff/u, "").trim() === VALID_ROSTER;
        await writeReport(reportPath(args), valid ? [] : [1]);
        return { code: valid ? 0 : 1, stdout: valid ? "OK" : "角色表错误", stderr: "" };
      }
      const parsed = await readCsvFile(csvPath);
      const scoped = args.find((arg) => arg.startsWith("--rows="))
        ?.slice("--rows=".length).split(",").map(Number)
        ?? parsed.rows.map((row) => Number(row["编号"]));
      const byIndex = new Map(parsed.rows.map((row) => [Number(row["编号"]), row]));
      const bad = scoped.filter((index) => {
        const value = byIndex.get(index)?.["画面提示词"] ?? "";
        return !value.trim() || value.includes("坏提示") || value.includes("越权");
      });
      await writeReport(reportPath(args), bad);
      return { code: bad.length > 0 ? 1 : 0, stdout: bad.length > 0 ? "D列错误" : "OK", stderr: "" };
    };

    const result = await runOriginalAgentInference({
      text: rows(61).map((row) => row["原声"]).join(""),
      title,
      genre: "玄幻",
      workDir: directory,
      runtime: inferenceRuntimePaths(join(process.cwd(), "vendor")),
      agent: {
        claudePath: "C:\\runtime\\claude.exe",
        baseUrl: "https://api.example.test",
        apiKey: "test-key",
        model: "agent-model",
      },
      context: context(),
      runAgent,
      runScript,
    });

    // The failed 20-shot batch is repaired, then the next batch deliberately shrinks back to 10.
    expect(batchCalls.map((batch) => batch.length)).toEqual([10, 20, 10, 20, 1]);
    expect(repairCalls).toContainEqual([11]);
    expect(result.model).toBe("agent-model");
    expect(result.usage.at(-1)).toEqual({
      sessionId: "mock-session",
      model: "semantic-agent-model",
      eventCount: 3,
      exitCode: 0,
    });
    expect(JSON.stringify(result.usage)).not.toContain("test-key");
    expect(result.characters).toHaveLength(1);
    expect(result.storyboards).toHaveLength(61);
    expect(result.storyboards[0]).toMatchObject({
      originalText: rows(61)[0]["原声"],
      duration: 4,
      prompt: prompt(1, true),
      subjects: ["江青璃"],
    });
    expect(await readFile(rosterPath, "utf8")).toBe(VALID_ROSTER);
    expect(await readFile(join(directory, `${title}.txt`), "utf8")).toBe(rows(61).map((row) => row["原声"]).join(""));
    expect(await readFile(join(directory, ".claude", "skills", "ai-tool-fenjing", "SKILL.md"), "utf8"))
      .toContain("name: ai-tool-fenjing");
    expect(await readFile(join(directory, "scripts", "check_dcol.py"), "utf8")).toContain("D列画面提示词校验脚本");
  });

  it("repairs a skeleton that filled D before entering batch generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-tool-agent-skeleton-repair-"));
    temporaryDirectories.push(directory);
    const title = "骨架修复";
    const csvPath = join(directory, `${title}.csv`);
    let skeletonRepairs = 0;
    const runAgent: OriginalAgentCall = async (request) => {
      if (request.prompt.includes("/ai-tool-fenjing")) {
        await writeFile(join(directory, "角色表.txt"), VALID_ROSTER, "utf8");
        const initial = rows(1);
        initial[0]["画面提示词"] = prompt(1);
        await writeCsvFileAtomic(csvPath, initial, { columns: COLUMNS, bom: true });
      } else if (request.prompt.includes("Rust最终复验发现")) {
        skeletonRepairs += 1;
        await patchRows(csvPath, [1], () => "");
      } else if (batchIndexes(request.prompt)) {
        await patchRows(csvPath, [1], (index) => prompt(index));
      }
      return agentResult();
    };
    const runScript: OriginalInferenceScriptCall = async () => ({ code: 0, stdout: "OK", stderr: "" });

    const result = await runOriginalAgentInference({
      text: rows(1)[0]["原声"],
      title,
      genre: "玄幻",
      workDir: directory,
      runtime: inferenceRuntimePaths(join(process.cwd(), "vendor")),
      agent: {
        claudePath: "claude.exe",
        baseUrl: "https://api.example.test",
        apiKey: "test-key",
        model: "agent-model",
      },
      context: context(),
      runAgent,
      runScript,
    });

    expect(skeletonRepairs).toBe(1);
    expect(result.storyboards[0].prompt).toBe(prompt(1));
    expect(result.stages).toContain("assets-repair");
  });

  it("propagates abort reasons without converting them into validation or pause errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-tool-agent-abort-"));
    temporaryDirectories.push(directory);
    const controller = new AbortController();
    const reason = new Error("用户暂停任务");
    const runAgent: OriginalAgentCall = async () => {
      controller.abort(reason);
      throw reason;
    };

    await expect(runOriginalAgentInference({
      text: "江青璃抬起右手凝视前方。",
      title: "中止传播",
      genre: "玄幻",
      workDir: directory,
      runtime: inferenceRuntimePaths(join(process.cwd(), "vendor")),
      agent: {
        claudePath: "claude.exe",
        baseUrl: "https://api.example.test",
        apiKey: "test-key",
        model: "agent-model",
      },
      context: context(controller.signal),
      runAgent,
    })).rejects.toBe(reason);
  });

  it("preserves generated files and raises PauseJobError after bounded skeleton repairs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-tool-agent-pause-"));
    temporaryDirectories.push(directory);
    const title = "暂停现场";
    const csvPath = join(directory, `${title}.csv`);
    let agentCalls = 0;
    const runAgent: OriginalAgentCall = async () => {
      agentCalls += 1;
      await writeFile(join(directory, "角色表.txt"), VALID_ROSTER, "utf8");
      await writeCsvFileAtomic(csvPath, rows(1), { columns: COLUMNS, bom: true });
      return agentResult();
    };
    const runScript: OriginalInferenceScriptCall = async (_runtime, script, args) => {
      const failed = script === "check_bcol.py";
      await writeReport(reportPath(args), failed ? [1] : []);
      return { code: failed ? 1 : 0, stdout: failed ? "B列始终失败" : "OK", stderr: "" };
    };

    const promise = runOriginalAgentInference({
      text: rows(1)[0]["原声"],
      title,
      genre: "玄幻",
      workDir: directory,
      runtime: inferenceRuntimePaths(join(process.cwd(), "vendor")),
      agent: {
        claudePath: "claude.exe",
        baseUrl: "https://api.example.test",
        apiKey: "test-key",
        model: "agent-model",
      },
      context: context(),
      runAgent,
      runScript,
    });

    await expect(promise).rejects.toBeInstanceOf(PauseJobError);
    expect(agentCalls).toBe(4);
    expect(await readFile(csvPath, "utf8")).toContain("编号,原声,秒数,画面提示词");
    expect(await readFile(join(directory, "failure_diagnostics.txt"), "utf8")).toContain("stage=skeleton");
  });
});
