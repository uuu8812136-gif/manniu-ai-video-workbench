import type { WorkflowJob, WorkflowJobEvent } from "../../../shared/contracts";

export type OpeningVariant = {
  index: number;
  direction: string;
  structure: string;
  score: number | null;
  text: string;
};

export type OpeningResult = {
  genre: string;
  openings: OpeningVariant[];
  body: string;
};

export type TrackedWorkflowJob = {
  jobId: string | null;
  job: WorkflowJob | null;
};

export type PolishWorkbenchMode = "original" | "advanced";
export type PolishDocumentCandidate = { name?: string; format?: "txt" | "docx" };
export type SingleTextWorkflowKind = "opening" | "polish";

export type RestoredSingleTextWorkflow = {
  job: WorkflowJob;
  text: string;
  title: string;
  outputDirectory: string;
  openingMode: "general" | "enhanced";
  polishMode: PolishWorkbenchMode;
  polishSourceFormat: "txt" | "docx" | null;
};

const RECOVERABLE_SINGLE_TEXT_STATUSES = new Set(["queued", "running", "paused", "error", "cancelled"]);

export function singleTextWorkflowStorageKey(kind: SingleTextWorkflowKind): string {
  return `ai-tool.text-workbench.${kind}.job.v1`;
}

export function restoreSingleTextWorkflow(
  kind: SingleTextWorkflowKind,
  jobs: WorkflowJob[],
  trackedJobId: string | null,
): RestoredSingleTextWorkflow | null {
  const expectedType = kind === "opening" ? "opening.optimize" : "text.polish";
  const candidates = jobs.filter((job) => job.type === expectedType);
  const tracked = trackedJobId ? candidates.find((job) => job.id === trackedJobId) : undefined;
  const job = tracked ?? candidates
    .filter((candidate) => RECOVERABLE_SINGLE_TEXT_STATUSES.has(candidate.status))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  if (!job?.input || typeof job.input !== "object") return null;

  const input = job.input as {
    text?: unknown;
    title?: unknown;
    outDir?: unknown;
    mode?: unknown;
    sourceFormat?: unknown;
  };
  if (typeof input.text !== "string" || !input.text.trim()) return null;
  const openingMode = input.mode === "enhanced" ? "enhanced" : "general";
  const polishMode = input.mode === "advanced" ? "advanced" : "original";
  const polishSourceFormat = input.sourceFormat === "docx"
    ? "docx"
    : input.sourceFormat === "txt" || polishMode === "original"
      ? "txt"
      : null;
  return {
    job,
    text: input.text,
    title: typeof input.title === "string" ? input.title : "",
    outputDirectory: typeof input.outDir === "string" ? input.outDir : "",
    openingMode,
    polishMode,
    polishSourceFormat,
  };
}

export function polishDocumentPickerInput(mode: PolishWorkbenchMode): { multiple: false; txtOnly: boolean } {
  return { multiple: false, txtOnly: mode === "original" };
}

function polishCandidateFormat(candidate: PolishDocumentCandidate): "txt" | "docx" | "other" {
  if (candidate.format) return candidate.format;
  if (/\.txt$/i.test(candidate.name ?? "")) return "txt";
  if (/\.docx$/i.test(candidate.name ?? "")) return "docx";
  return "other";
}

export function polishDocumentSelectionError(
  mode: PolishWorkbenchMode,
  candidates: readonly PolishDocumentCandidate[],
): string | null {
  if (mode !== "original" || candidates.length === 0) return null;
  if (candidates.length > 1) return "原版模式一次只能导入一个 TXT 文件";
  return polishCandidateFormat(candidates[0]!) === "txt" ? null : "原版模式仅支持 TXT 文件";
}

export function polishInputValidationError(
  mode: PolishWorkbenchMode,
  sourceFormat: "txt" | "docx" | null,
): string | null {
  return mode === "original" && sourceFormat !== "txt" ? "原版模式请先导入单个 TXT 文件" : null;
}

const openingHeader = /^\s*(?:[-=—]{2,}\s*)?开头\s*(\d+)\s*[（(]([^）)]*)[）)]\s*(?:[-=—]{2,})?\s*$/;

function openingMetadata(value: string): Pick<OpeningVariant, "direction" | "structure" | "score"> {
  let direction = "";
  let structure = "";
  let score: number | null = null;
  for (const part of value.split(/[，,]/)) {
    const item = part.trim();
    if (/^方向[:：]/.test(item)) direction = item.replace(/^方向[:：]\s*/, "");
    else if (/^结构[:：]/.test(item)) structure = item.replace(/^结构[:：]\s*/, "");
    else if (/^得分[:：]/.test(item)) {
      const matched = item.match(/\d+/);
      if (matched) score = Number(matched[0]);
    }
  }
  return { direction, structure, score };
}

export function parseOpeningResult(text: string): OpeningResult {
  const lines = text.split(/\r?\n/);
  const genre = lines.find((line) => /^【题材】/.test(line.trim()))?.trim().replace(/^【题材】\s*/, "").replace(/[，,]\s*对应参考库.*$/, "").trim() ?? "";
  const openings: OpeningVariant[] = [];
  let current: OpeningVariant | null = null;
  let bodyStart = -1;

  const flush = (): void => {
    if (!current) return;
    current.text = current.text.trim();
    if (current.text) openings.push(current);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/抓取正文|正文优化/.test(trimmed)) {
      flush();
      bodyStart = index + 1;
      continue;
    }
    const header = trimmed.match(openingHeader);
    if (header) {
      flush();
      current = { index: Number(header[1]), ...openingMetadata(header[2]), text: "" };
      continue;
    }
    if (current && !/^[═=]{6,}$/.test(trimmed)) current.text += `${current.text ? "\n" : ""}${line}`;
  }
  flush();

  const body = bodyStart >= 0
    ? lines.slice(bodyStart).filter((line, index) => !(index === 0 && /^[═=]{6,}$/.test(line.trim()))).join("\n").trim()
    : "";
  return { genre, openings: openings.sort((left, right) => (right.score ?? -1) - (left.score ?? -1)), body };
}

export function nonWhitespaceLength(text: string): number {
  return text.replace(/\s/g, "").length;
}

export function fileStem(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  return name.replace(/\.(?:txt|docx)$/i, "") || "未命名文案";
}

export function safeWindowsName(value: string, fallback = "未命名文案"): string {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 160);
  return sanitized || fallback;
}

export function textOutputName(title: string, suffix: string): string {
  return `${safeWindowsName(title)}_${safeWindowsName(suffix, "结果")}.txt`;
}

export function childDirectory(parent: string, title: string): string {
  const separator = parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${safeWindowsName(title)}`;
}

export function resolveWorkflowOutputDirectory(
  saved: string | null | undefined,
  documentsDirectory: string,
  defaultFolder?: string,
): string {
  const configured = saved?.trim();
  if (configured) return configured;
  return defaultFolder ? childDirectory(documentsDirectory, defaultFolder) : "";
}

export function mergeTrackedWorkflowJobs<T extends TrackedWorkflowJob>(tasks: T[], jobs: WorkflowJob[]): T[] {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  return tasks.map((task) => {
    if (!task.jobId) return task;
    const job = byId.get(task.jobId);
    return job && job !== task.job ? { ...task, job } : task;
  });
}

export function canStopWorkflowJob(job: WorkflowJob | null): boolean {
  return job?.status === "queued" || job?.status === "running" || job?.status === "paused";
}

export function canRetryWorkflowJob(job: WorkflowJob | null): boolean {
  return job?.status === "error" || job?.status === "cancelled";
}

export function recoveryWorkDirectory(events: WorkflowJobEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const detail = events[index]?.detail;
    if (!detail || typeof detail !== "object") continue;
    const workDir = (detail as { workDir?: unknown }).workDir;
    if (typeof workDir === "string" && workDir.trim()) return workDir.trim();
  }
  return "";
}
