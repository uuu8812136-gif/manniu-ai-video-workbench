import { create } from "zustand";
import type {
  ImportedDocumentFile,
  Project,
  WorkflowJob,
  WorkflowJobEvent,
} from "../../../shared/contracts";

export type InferenceSource = ImportedDocumentFile & {
  sourceId: string;
  title: string;
};

export type InferencePauseDiagnostics = {
  stage: string;
  workDir: string;
  reportPaths: string[];
  errorCategory: string;
  completedIndexes: number[];
};

export type InferenceTask = {
  taskId: string;
  source: InferenceSource;
  genre: string;
  project: Project | null;
  jobId: string | null;
  job: WorkflowJob | null;
  stage: string;
  detail?: string;
  diagnostics?: InferencePauseDiagnostics;
  workDir?: string;
  error: string;
  initializing: boolean;
  stopped: boolean;
};

type StateUpdate<T> = T | ((current: T) => T);

type InferenceWorkbenchState = {
  sources: InferenceSource[];
  genre: string;
  tasks: InferenceTask[];
  setSources(update: StateUpdate<InferenceSource[]>): void;
  setGenre(genre: string): void;
  setTasks(update: StateUpdate<InferenceTask[]>): void;
  reset(): void;
};

function resolveUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === "function"
    ? (update as (value: T) => T)(current)
    : update;
}

const initialState = {
  sources: [] as InferenceSource[],
  genre: "auto",
  tasks: [] as InferenceTask[],
};

export const cancelledInferenceTaskIds = new Set<string>();

export function inferenceStageLabel(message: string): string {
  const value = message.trim();
  if (!value) return "准备中";
  if (value.includes("写分镜") || value.includes("生成画面")) return "写分镜";
  if (value.includes("生成资产") || value.includes("角色表")) return "生成资产";
  if (value.includes("智能分句") || value.includes("分句")) return "分句";
  if (value.includes("分镜骨架") || value.includes("骨架")) return "建骨架";
  if (value.includes("主体计划")) return "主体计划";
  if (value.includes("补写")) return "补写";
  if (value.includes("错误修复") || value.includes("修复")) return "修复分镜";
  if (value.includes("校验")) return "校验分镜";
  if (value.includes("整理") || value.includes("保存") || value.includes("提交")) return "整理产物";
  if (value.includes("准备")) return "准备中";
  if (value.includes("排队")) return "排队中";
  return value.replace(/\s+\d+\/\d+$/u, "");
}

export function latestInferenceProgressDetail(events: WorkflowJobEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event.detail || typeof event.detail !== "object") continue;
    if (typeof (event.detail as { progress?: unknown }).progress === "number") return event.message.trim();
  }
  return "";
}

export function latestInferencePauseDiagnostics(events: WorkflowJobEvent[]): InferencePauseDiagnostics | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const detail = events[index]?.detail;
    if (!detail || typeof detail !== "object") continue;
    const value = detail as Record<string, unknown>;
    if (
      typeof value.stage !== "string"
      || typeof value.workDir !== "string"
      || !Array.isArray(value.reportPaths)
      || typeof value.errorCategory !== "string"
      || !Array.isArray(value.completedIndexes)
    ) continue;
    const reportPaths = value.reportPaths.filter((path): path is string => typeof path === "string" && path.trim().length > 0);
    const completedIndexes = value.completedIndexes.filter((shot): shot is number => Number.isInteger(shot) && shot > 0);
    return {
      stage: value.stage.trim(),
      workDir: value.workDir.trim(),
      reportPaths,
      errorCategory: value.errorCategory.trim(),
      completedIndexes,
    };
  }
  return undefined;
}

export function restoreInferenceTasks(
  jobs: WorkflowJob[],
  projects: Project[],
  workDirectories: ReadonlyMap<string, string> = new Map(),
  diagnosticsByJob: ReadonlyMap<string, InferencePauseDiagnostics> = new Map(),
): InferenceTask[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  return jobs
    .filter((job) => job.type === "storyboard.infer" && ["queued", "running", "paused", "error"].includes(job.status))
    .flatMap((job): InferenceTask[] => {
      if (!job.input || typeof job.input !== "object") return [];
      const input = job.input as { text?: unknown; genre?: unknown; projectId?: unknown };
      if (typeof input.text !== "string" || !input.text.trim() || !Number.isInteger(input.projectId)) return [];
      const project = projectsById.get(Number(input.projectId));
      if (!project) return [];
      const stage = job.status === "error"
        ? "校验未通过，待修复"
        : job.status === "paused"
          ? "已暂停"
          : job.status === "queued"
            ? "排队中：等待生成引擎接手"
            : "正在恢复任务进度";
      return [{
        taskId: job.id,
        source: {
          sourceId: job.id,
          path: project.folderPath,
          title: project.name,
          format: "txt",
          text: input.text,
          encoding: "utf-8",
          hadBom: false,
          warnings: [],
        },
        genre: typeof input.genre === "string" && input.genre.trim() ? input.genre : "auto",
        project,
        jobId: job.id,
        job,
        stage,
        diagnostics: diagnosticsByJob.get(job.id),
        workDir: workDirectories.get(job.id) ?? "",
        error: job.error ?? "",
        initializing: false,
        stopped: false,
      }];
    });
}

export const useInferenceWorkbenchStore = create<InferenceWorkbenchState>((set) => ({
  ...initialState,
  setSources: (update) => set((state) => ({ sources: resolveUpdate(state.sources, update) })),
  setGenre: (genre) => set({ genre }),
  setTasks: (update) => set((state) => ({ tasks: resolveUpdate(state.tasks, update) })),
  reset: () => {
    cancelledInferenceTaskIds.clear();
    set({ ...initialState });
  },
}));
