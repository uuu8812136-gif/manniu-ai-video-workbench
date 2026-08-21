import { describe, expect, it } from "vitest";
import type { WorkflowJob } from "../src/shared/contracts";
import { restoreInferenceTasks } from "../src/renderer/src/pages/inference-workbench-state";
import {
  canRetryWorkflowJob,
  canStopWorkflowJob,
  childDirectory,
  fileStem,
  mergeTrackedWorkflowJobs,
  nonWhitespaceLength,
  parseOpeningResult,
  polishDocumentPickerInput,
  polishDocumentSelectionError,
  polishInputValidationError,
  recoveryWorkDirectory,
  restoreSingleTextWorkflow,
  resolveWorkflowOutputDirectory,
  safeWindowsName,
  textOutputName,
  type TrackedWorkflowJob,
} from "../src/renderer/src/pages/text-workbench-state";

function job(id: string, status: WorkflowJob["status"], projectId: number): WorkflowJob {
  return {
    id,
    type: "storyboard.infer",
    status,
    progress: status === "done" ? 100 : 40,
    input: { projectId },
    output: null,
    error: status === "error" ? "failed" : null,
    attempts: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("text workbench state", () => {
  it("parses and sorts original-style opening variants", () => {
    const result = parseOpeningResult(`【题材】 悬疑\n备选开头\n—— 开头 1（方向：反转，结构：倒叙，得分：82） ——\n第一个\n—— 开头 2（方向：冲突，结构：直入，得分：95） ——\n第二个\n抓取正文（原文，未优化）\n========\n正文`);
    expect(result.genre).toBe("悬疑");
    expect(result.openings.map((item) => item.index)).toEqual([2, 1]);
    expect(result.openings[0]?.direction).toBe("冲突");
    expect(result.body).toBe("正文");
  });

  it("handles counts and Windows file names", () => {
    expect(nonWhitespaceLength("一 二\n三")).toBe(3);
    expect(fileStem("D:\\稿件\\故事.docx")).toBe("故事");
    expect(safeWindowsName('第 1 章：开场<>"/\\|?*. ')).toBe("第 1 章：开场________");
    expect(textOutputName("都市/故事", "开头优化")).toBe("都市_故事_开头优化.txt");
    expect(childDirectory("D:\\输出\\", "都市/故事")).toBe("D:\\输出\\都市_故事");
  });

  it("uses the original output-directory defaults per text workflow", () => {
    expect(resolveWorkflowOutputDirectory(" D:\\自选目录 ", "C:\\Users\\demo\\Documents", "AI工具捋文"))
      .toBe("D:\\自选目录");
    expect(resolveWorkflowOutputDirectory(null, "C:\\Users\\demo\\Documents", "AI工具捋文"))
      .toBe("C:\\Users\\demo\\Documents\\AI工具捋文");
    expect(resolveWorkflowOutputDirectory(null, "C:\\Users\\demo\\Documents")).toBe("");
  });

  it("merges parallel jobs by exact id without crossing project inputs", () => {
    const first = job("first", "running", 11);
    const second = job("second", "done", 22);
    const sourceTasks: Array<TrackedWorkflowJob & { title: string }> = [
      { title: "甲", jobId: "first", job: null },
      { title: "乙", jobId: "second", job: null },
    ];
    const tasks = mergeTrackedWorkflowJobs(sourceTasks, [second, first]);

    expect(tasks.map((task) => (task.job?.input as { projectId: number }).projectId)).toEqual([11, 22]);
    expect(canStopWorkflowJob(tasks[0]?.job ?? null)).toBe(true);
    expect(canRetryWorkflowJob(tasks[0]?.job ?? null)).toBe(false);
    expect(canStopWorkflowJob(tasks[1]?.job ?? null)).toBe(false);
    expect(canRetryWorkflowJob(job("failed", "error", 33))).toBe(true);
    expect(canRetryWorkflowJob(job("stopped", "cancelled", 44))).toBe(true);
  });

  it("enforces the original polish mode as one imported TXT document", () => {
    expect(polishDocumentPickerInput("original")).toEqual({ multiple: false, txtOnly: true });
    expect(polishDocumentSelectionError("original", [{ name: "story.txt" }])).toBeNull();
    expect(polishDocumentSelectionError("original", [{ name: "story.docx" }])).toBe("原版模式仅支持 TXT 文件");
    expect(polishDocumentSelectionError("original", [{ name: "one.txt" }, { name: "two.txt" }]))
      .toBe("原版模式一次只能导入一个 TXT 文件");
    expect(polishInputValidationError("original", null)).toBe("原版模式请先导入单个 TXT 文件");
    expect(polishInputValidationError("original", "docx")).toBe("原版模式请先导入单个 TXT 文件");
    expect(polishInputValidationError("original", "txt")).toBeNull();
  });

  it("keeps TXT, DOCX and direct text available in advanced polish mode", () => {
    expect(polishDocumentPickerInput("advanced")).toEqual({ multiple: false, txtOnly: false });
    expect(polishDocumentSelectionError("advanced", [{ format: "docx" }])).toBeNull();
    expect(polishDocumentSelectionError("advanced", [{ name: "one.txt" }, { name: "two.docx" }])).toBeNull();
    expect(polishInputValidationError("advanced", null)).toBeNull();
  });

  it("restores the exact tracked text job and otherwise falls back only to unfinished work", () => {
    const opening = {
      ...job("opening", "done", 1),
      type: "opening.optimize" as const,
      input: { text: "开头原文", title: "开头标题", mode: "enhanced", outDir: "D:\\开头" },
      output: { text: "已完成开头" },
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    const polish = {
      ...job("polish", "running", 1),
      type: "text.polish" as const,
      input: { text: "捋文原文", title: "捋文标题", mode: "advanced", sourceFormat: "docx", outDir: "D:\\捋文" },
      updatedAt: "2026-01-04T00:00:00.000Z",
    };
    expect(restoreSingleTextWorkflow("opening", [polish, opening], "opening")).toMatchObject({
      job: { id: "opening", status: "done" },
      openingMode: "enhanced",
      text: "开头原文",
    });
    expect(restoreSingleTextWorkflow("polish", [opening, polish], null)).toMatchObject({
      job: { id: "polish", status: "running" },
      polishMode: "advanced",
      polishSourceFormat: "docx",
      outputDirectory: "D:\\捋文",
    });
    expect(restoreSingleTextWorkflow("opening", [opening], null)).toBeNull();
  });

  it("extracts the retained inference work directory without using progress events", () => {
    expect(recoveryWorkDirectory([
      { id: 1, jobId: "job", level: "info", message: "started", detail: { progress: 3 }, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: 2, jobId: "job", level: "info", message: "恢复目录", detail: { workDir: "D:\\项目\\.ai-tool-inference\\job" }, createdAt: "2026-01-01T00:00:01.000Z" },
    ])).toBe("D:\\项目\\.ai-tool-inference\\job");
  });

  it("restores only recoverable inference jobs with their original project and work directory", () => {
    const project = {
      id: 7,
      name: "恢复项目",
      folderPath: "D:\\恢复项目",
      csvPath: "",
      rosterPath: "",
      subtitlePath: "",
      audioPath: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const failed = { ...job("failed", "error", 7), input: { projectId: 7, text: "原文", genre: "玄幻" } };
    const done = { ...job("done", "done", 7), input: { projectId: 7, text: "旧原文" } };
    expect(restoreInferenceTasks([failed, done], [project], new Map([["failed", "D:\\恢复项目\\.ai-tool-inference\\failed"]]))).toMatchObject([{
      jobId: "failed",
      project: { id: 7 },
      source: { title: "恢复项目", text: "原文" },
      stage: "校验未通过，待修复",
      workDir: "D:\\恢复项目\\.ai-tool-inference\\failed",
    }]);
  });
});
