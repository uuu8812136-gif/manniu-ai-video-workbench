import { afterEach, describe, expect, it } from "vitest";
import type { ImportedDocumentFile, WorkflowJob } from "../src/shared/contracts";
import {
  cancelledInferenceTaskIds,
  inferenceStageLabel,
  latestInferencePauseDiagnostics,
  latestInferenceProgressDetail,
  useInferenceWorkbenchStore,
  type InferenceSource,
  type InferenceTask,
} from "../src/renderer/src/pages/inference-workbench-state";

function source(): InferenceSource {
  return {
    sourceId: "source-1",
    title: "第一章",
    path: "D:\\小说\\第一章.txt",
    format: "txt",
    text: "正文",
    encoding: "utf-8",
    hadBom: false,
    warnings: [],
  } satisfies ImportedDocumentFile & InferenceSource;
}

function runningJob(): WorkflowJob {
  return {
    id: "job-1",
    type: "storyboard.infer",
    status: "running",
    progress: 42,
    input: { projectId: 7 },
    output: null,
    error: null,
    attempts: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("inference workbench state", () => {
  afterEach(() => useInferenceWorkbenchStore.getState().reset());

  it("keeps the original stage label separate from the latest progress detail", () => {
    const detail = latestInferenceProgressDetail([
      { id: 1, jobId: "job-1", level: "info", message: "推理恢复目录已准备", detail: { workDir: "D:\\项目" }, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: 2, jobId: "job-1", level: "info", message: "正在提交原版角色表、四列 CSV 和分句文件", detail: { progress: 95 }, createdAt: "2026-01-01T00:00:01.000Z" },
    ]);
    expect(detail).toBe("正在提交原版角色表、四列 CSV 和分句文件");
    expect(inferenceStageLabel(detail)).toBe("生成资产");
    expect(inferenceStageLabel("正在校验分镜结构")).toBe("校验分镜");
  });

  it("restores structured pause diagnostics from the latest job event", () => {
    expect(latestInferencePauseDiagnostics([
      { id: 1, jobId: "job-1", level: "info", message: "普通进度", detail: { progress: 80 }, createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: 2,
        jobId: "job-1",
        level: "warning",
        message: "Job paused for attention",
        detail: {
          stage: "full-table-repair",
          workDir: "D:\\项目\\.ai-tool-inference\\job-1",
          reportPaths: ["D:\\项目\\dcol_validation_report.json"],
          errorCategory: "DCOL.UNCLASSIFIED",
          completedIndexes: [1, 2, 3],
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ])).toEqual({
      stage: "full-table-repair",
      workDir: "D:\\项目\\.ai-tool-inference\\job-1",
      reportPaths: ["D:\\项目\\dcol_validation_report.json"],
      errorCategory: "DCOL.UNCLASSIFIED",
      completedIndexes: [1, 2, 3],
    });
  });

  it("keeps sources, genre and task cards in the module store across page remounts", () => {
    const task = {
      taskId: "task-1",
      source: source(),
      genre: "玄幻",
      project: null,
      jobId: "job-1",
      job: runningJob(),
      stage: "正在生成分镜",
      error: "",
      initializing: false,
      stopped: false,
    } satisfies InferenceTask;

    const firstMount = useInferenceWorkbenchStore.getState();
    firstMount.setSources([task.source]);
    firstMount.setGenre("玄幻");
    firstMount.setTasks([task]);

    const remounted = useInferenceWorkbenchStore.getState();
    expect(remounted.sources).toEqual([task.source]);
    expect(remounted.genre).toBe("玄幻");
    expect(remounted.tasks).toEqual([task]);
  });

  it("applies functional task updates and clears cancellation markers on reset", () => {
    const state = useInferenceWorkbenchStore.getState();
    state.setTasks([]);
    state.setTasks((current) => [...current, {
      taskId: "task-2",
      source: source(),
      genre: "auto",
      project: null,
      jobId: null,
      job: null,
      stage: "准备中",
      error: "",
      initializing: true,
      stopped: false,
    }]);
    cancelledInferenceTaskIds.add("task-2");

    expect(useInferenceWorkbenchStore.getState().tasks).toHaveLength(1);
    state.reset();
    expect(useInferenceWorkbenchStore.getState().tasks).toEqual([]);
    expect(cancelledInferenceTaskIds.size).toBe(0);
  });
});
