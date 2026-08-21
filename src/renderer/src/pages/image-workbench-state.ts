import type {
  StandaloneImageJobInput,
  StandaloneImageJobOutput,
  WorkflowJob,
  WorkflowJobStatus,
} from "../../../shared/contracts";

export type ImagePromptBatch = {
  name: string;
  prompt: string;
};

export type ImageWorkbenchResultStatus = "pending" | WorkflowJobStatus;

export type ImageWorkbenchResult = ImagePromptBatch & {
  key: string;
  batchName: string;
  jobId: string | null;
  status: ImageWorkbenchResultStatus;
  progress: number;
  error: string | null;
  imagePaths: string[];
  outputDirectory: string;
  updatedAt: string;
};

export type ImageBatchCompletion = {
  done: number;
  failed: number;
  cancelled: number;
  notice: string | null;
  error: string | null;
};

const IMAGE_BATCH_STORAGE_KEY = "ai-tool.image-workbench.batch.v1";
const RECOVERABLE_IMAGE_STATUSES = new Set<WorkflowJobStatus>(["queued", "running", "paused", "error", "cancelled"]);

export function imageBatchStorageKey(): string {
  return IMAGE_BATCH_STORAGE_KEY;
}

function standaloneInput(job: WorkflowJob): StandaloneImageJobInput | null {
  if (job.type !== "image.standalone" || !job.input || typeof job.input !== "object") return null;
  const input = job.input as Partial<StandaloneImageJobInput>;
  return Boolean(typeof input.name === "string"
    && typeof input.prompt === "string"
    && typeof input.batchName === "string"
    && input.name.trim()
    && input.prompt.trim()
    && input.batchName.trim())
    ? input as StandaloneImageJobInput
    : null;
}

function standaloneOutput(job: WorkflowJob): StandaloneImageJobOutput | null {
  if (!job.output || typeof job.output !== "object") return null;
  const output = job.output as Partial<StandaloneImageJobOutput>;
  return Array.isArray(output.imagePaths)
    && output.imagePaths.every((path) => typeof path === "string")
    && typeof output.outputDirectory === "string"
    ? output as StandaloneImageJobOutput
    : null;
}

export function restoreStandaloneImageBatch(
  jobs: WorkflowJob[],
  trackedBatchName: string | null,
): ImageWorkbenchResult[] {
  const candidates = jobs
    .map((job) => ({ job, input: standaloneInput(job) }))
    .filter((entry): entry is { job: WorkflowJob; input: StandaloneImageJobInput } => entry.input !== null);
  const activeFallback = [...candidates]
    .filter(({ job }) => job.status === "queued" || job.status === "running" || job.status === "paused")
    .sort((left, right) => Date.parse(right.job.updatedAt) - Date.parse(left.job.updatedAt))[0]?.input.batchName;
  const fallback = activeFallback ?? [...candidates]
    .filter(({ job }) => RECOVERABLE_IMAGE_STATUSES.has(job.status))
    .sort((left, right) => Date.parse(right.job.updatedAt) - Date.parse(left.job.updatedAt))[0]?.input.batchName;
  const batchName = trackedBatchName && candidates.some(({ input }) => input.batchName === trackedBatchName)
    ? trackedBatchName
    : fallback;
  if (!batchName) return [];

  const latestByWorkbenchKey = new Map<string, { job: WorkflowJob; input: StandaloneImageJobInput }>();
  for (const entry of candidates.filter(({ input }) => input.batchName === batchName)) {
    const key = inputWorkbenchKey(entry.input, entry.job.id);
    const current = latestByWorkbenchKey.get(key);
    if (!current || Date.parse(entry.job.createdAt) >= Date.parse(current.job.createdAt)) latestByWorkbenchKey.set(key, entry);
  }

  return [...latestByWorkbenchKey.values()]
    .sort((left, right) => Date.parse(left.job.createdAt) - Date.parse(right.job.createdAt))
    .map(({ job, input }) => {
      const output = standaloneOutput(job);
      return {
        key: inputWorkbenchKey(input, job.id),
        name: input.name,
        prompt: input.prompt,
        batchName: input.batchName,
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        error: job.error,
        imagePaths: output?.imagePaths ?? [],
        outputDirectory: output?.outputDirectory ?? input.outputDirectory ?? "",
        updatedAt: job.updatedAt,
      };
    });
}

function inputWorkbenchKey(input: StandaloneImageJobInput, fallback: string): string {
  return typeof input.workbenchKey === "string" && input.workbenchKey.trim() ? input.workbenchKey : fallback;
}

export function summarizeImageBatchCompletion(statuses: readonly ImageWorkbenchResultStatus[]): ImageBatchCompletion {
  const done = statuses.filter((status) => status === "done").length;
  const failed = statuses.filter((status) => status === "error").length;
  const cancelled = statuses.filter((status) => status === "cancelled").length;
  if (done === 0) {
    return {
      done,
      failed,
      cancelled,
      notice: null,
      error: `本批次没有生成成功：失败 ${failed}，已停止 ${cancelled}`,
    };
  }
  const suffix = failed > 0 || cancelled > 0 ? `，失败 ${failed}，已停止 ${cancelled}` : "";
  return {
    done,
    failed,
    cancelled,
    notice: `本批次已处理完成：成功 ${done}${suffix}，成功结果已保存到独立目录`,
    error: failed > 0 ? `${failed} 条提示词生成失败，请查看对应错误` : null,
  };
}

export type ImageModelConfig = {
  maxCount: number;
  maxConcurrency: number;
  defaultConcurrency: number;
  resolutions: string[];
  sizes: Record<string, Record<string, string>>;
};

export function hasConfiguredImageApiKey(settings: Readonly<Record<string, string>>): boolean {
  return Boolean(settings.imagegen_api_key?.trim() || settings.imagegen_api_keys?.trim());
}

export const IMAGE_MODEL_CONFIGS: Record<string, ImageModelConfig> = {
  "gpt-image-2": {
    maxCount: 10,
    maxConcurrency: 4,
    defaultConcurrency: 3,
    resolutions: ["1K"],
    sizes: {
      "16:9": { "1K": "1920x1080" },
      "9:16": { "1K": "1080x1920" },
      "1:1": { "1K": "1024x1024" },
      "4:3": { "1K": "1536x1152" },
      "3:4": { "1K": "1536x2048" },
      "3:2": { "1K": "1536x1024" },
      "2:3": { "1K": "1024x1536" },
    },
  },
  "gpt-image-2-pro": {
    maxCount: 10,
    maxConcurrency: 2,
    defaultConcurrency: 2,
    resolutions: ["2K", "4K"],
    sizes: {
      "16:9": { "2K": "2048x1152", "4K": "3840x2160" },
      "9:16": { "2K": "1152x2048", "4K": "2160x3840" },
      "1:1": { "2K": "2048x2048", "4K": "2880x2880" },
      "4:3": { "2K": "2048x1536", "4K": "3840x2880" },
      "3:4": { "2K": "1536x2048", "4K": "2880x3840" },
      "3:2": { "2K": "2560x1712", "4K": "3840x2560" },
      "2:3": { "2K": "1712x2560", "4K": "2560x3840" },
    },
  },
  "banana-pro": {
    maxCount: 10,
    maxConcurrency: 4,
    defaultConcurrency: 3,
    resolutions: ["1K"],
    sizes: {
      "16:9": { "1K": "1024x576" },
      "9:16": { "1K": "576x1024" },
      "1:1": { "1K": "1024x1024" },
      "4:3": { "1K": "1024x768" },
      "3:4": { "1K": "768x1024" },
      "3:2": { "1K": "1152x768" },
      "2:3": { "1K": "768x1152" },
    },
  },
};

const FALLBACK_MODEL_CONFIG: ImageModelConfig = {
  maxCount: 10,
  maxConcurrency: 4,
  defaultConcurrency: 3,
  resolutions: ["默认"],
  sizes: Object.fromEntries(["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"].map((aspect) => [aspect, { "默认": "" }])),
};

export function parsePromptBatches(value: string, limit = 100): ImagePromptBatch[] {
  return value.split(/^\s*###\s*$/m).flatMap((block): ImagePromptBatch[] => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    if (lines.length === 0) return [];
    return [{ name: lines[0], prompt: lines[lines.length - 1] }];
  }).slice(0, Math.max(0, limit));
}

export function normalizeEditedImagePrompt(value: string): string | null {
  const prompt = value.trim();
  return prompt || null;
}

export function imageModelConfig(model: string): ImageModelConfig {
  return IMAGE_MODEL_CONFIGS[model] ?? FALLBACK_MODEL_CONFIG;
}

export function clampImageCount(model: string, value: number): number {
  const maximum = imageModelConfig(model).maxCount;
  return Math.min(maximum, Math.max(1, Number.isFinite(value) ? Math.round(value) : 1));
}

export function clampImageConcurrency(model: string, value: number): number {
  const maximum = imageModelConfig(model).maxConcurrency;
  return Math.min(maximum, Math.max(1, Number.isFinite(value) ? Math.round(value) : 1));
}

export function normalizeImageSelection(model: string, aspect?: string, resolution?: string): {
  aspect: string;
  resolution: string;
  size: string;
} {
  const config = imageModelConfig(model);
  const nextAspect = aspect && config.sizes[aspect] ? aspect : Object.keys(config.sizes)[0];
  const sizes = config.sizes[nextAspect];
  const nextResolution = resolution && sizes[resolution] ? resolution : Object.keys(sizes)[0];
  return { aspect: nextAspect, resolution: nextResolution, size: sizes[nextResolution] };
}
