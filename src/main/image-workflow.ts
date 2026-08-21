import { extname, join, resolve } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { z } from "zod";
import { ApiKeyPool, parseApiKeys } from "./api-key-pool";
import { GeminiImageClient } from "./gemini-client";
import { imageProviderCompatibilityError } from "./image-provider";
import { persistGeneratedImage } from "./image-assets";
import { characterAssetPrompt, persistCharacterAsset } from "./character-assets";
import type { JobExecutionContext, JobHandler } from "./jobs";
import { ModelApiError, OpenAIModelClient, type GeneratedImage, type ImagesResult } from "./model-clients";
import { CharacterProfileRepository, ProjectRepository, StoryboardRepository } from "./repositories";
import type { SettingsStorage } from "./secure-settings";

export const imageGenerationInput = z.object({
  storyboardId: z.number().int().positive(),
  characterProfileId: z.number().int().positive().optional(),
  prompt: z.string().trim().max(20_000).optional(),
  model: z.string().trim().max(160).optional(),
  count: z.number().int().min(1).max(10).optional(),
  size: z.string().trim().max(40).optional(),
  quality: z.string().trim().max(40).optional(),
  aspectRatio: z.string().trim().max(20).optional(),
  referenceImagePaths: z.array(z.string().trim().min(1).max(32_767)).max(4).optional(),
});

export type ImageGenerationInput = z.infer<typeof imageGenerationInput>;

export const standaloneImageGenerationInput = imageGenerationInput.omit({ storyboardId: true }).extend({
  prompt: z.string().trim().min(1).max(20_000),
  name: z.string().trim().min(1).max(160),
  batchName: z.string().trim().min(1).max(160),
  outputDirectory: z.string().trim().min(1).max(32_767).optional(),
  workbenchKey: z.string().trim().min(1).max(240).optional(),
});

export type StandaloneImageGenerationInput = z.infer<typeof standaloneImageGenerationInput>;
export type StandaloneImageGenerationOutput = {
  imagePath: string;
  imagePaths: string[];
  outputDirectory: string;
  provider: string;
};

function required(settings: Pick<SettingsStorage, "get">, key: string, label: string): string {
  const value = settings.get(key)?.trim();
  if (!value) throw new Error(`请先在设置中配置${label}`);
  return value;
}

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 32) : fallback;
}

function safeDirectoryName(value: string): string {
  const safe = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
  return safe.slice(0, 120) || "project";
}

function retryDetail(error: unknown, attempt: number): Record<string, unknown> {
  return error instanceof ModelApiError
    ? { attempt, kind: error.kind, status: error.status ?? null, requestId: error.requestId ?? null }
    : { attempt };
}

async function loadReferenceImages(paths: string[]): Promise<Array<{ mimeType: string; base64: string }>> {
  return Promise.all(paths.map(async (path) => {
    const mimeType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<string, string>)[extname(path).toLowerCase()];
    if (!mimeType) throw new Error(`参考图格式不支持: ${path}`);
    const bytes = await readFile(path);
    if (bytes.length === 0) throw new Error(`参考图为空: ${path}`);
    if (bytes.length > 20 * 1024 * 1024) throw new Error(`参考图超过 20 MB: ${path}`);
    const { nativeImage } = await import("electron");
    let image = nativeImage.createFromBuffer(bytes);
    const size = image.getSize();
    if (image.isEmpty() || size.width <= 0 || size.height <= 0) throw new Error(`参考图解码失败: ${path}`);
    if (size.width > 1024 || size.height > 1024) {
      const scale = 1024 / Math.max(size.width, size.height);
      image = image.resize({
        width: Math.round(size.width * scale),
        height: Math.round(size.height * scale),
        quality: "best",
      });
    }
    const png = image.toPNG();
    if (png.length === 0) throw new Error(`参考图转 PNG 失败: ${path}`);
    return { mimeType: "image/png", base64: png.toString("base64") };
  }));
}

async function requestGeneratedImages(
  options: { settings: Pick<SettingsStorage, "get">; keyPool: ApiKeyPool },
  input: Omit<ImageGenerationInput, "storyboardId"> & { prompt: string },
  context: JobExecutionContext,
): Promise<{ images: GeneratedImage[]; provider: "openai" | "gemini" }> {
  const provider = (options.settings.get("imagegen_provider")?.trim().toLowerCase() || "openai") as
    | "openai"
    | "gemini";
  if (provider !== "openai" && provider !== "gemini") throw new Error(`不支持的生图服务: ${provider}`);
  const baseUrl = required(options.settings, "imagegen_api_base_url", "生图 API 地址");
  const model = input.model?.trim() || required(options.settings, "imagegen_model", "生图模型");
  const compatibilityError = imageProviderCompatibilityError(provider, model);
  if (compatibilityError) throw new Error(compatibilityError);
  const count = input.count ?? 1;
  const referenceImages = await loadReferenceImages(input.referenceImagePaths ?? []);
  const keys = parseApiKeys(
    options.settings.get("imagegen_api_key"),
    options.settings.get("imagegen_api_keys"),
  );
  const concurrencyPerKey = positiveInteger(options.settings.get("imagegen_concurrency_per_key"), 2);

  context.updateProgress(8, "正在连接生图模型", { provider });
  const request = (requestedCount: number): Promise<ImagesResult> => options.keyPool.run<ImagesResult>({
    keys,
    concurrencyPerKey,
    signal: context.signal,
    operation: (apiKey) => {
      if (provider === "gemini") {
        return new GeminiImageClient({ baseUrl, apiKey, timeoutMs: 180_000 }).images(
          { model, prompt: input.prompt, aspectRatio: input.aspectRatio, referenceImages },
          { signal: context.signal },
        );
      }
      return new OpenAIModelClient({ baseUrl, apiKey, timeoutMs: 180_000 }).images(
        {
          model,
          prompt: input.prompt,
          n: requestedCount,
          response_format: "url",
          ...(referenceImages.length > 0
            ? { reference_images: referenceImages.map(({ base64 }) => base64) }
            : {}),
          ...(input.size ? { size: input.size } : {}),
          quality: input.quality ?? "high",
        },
        { signal: context.signal },
      );
    },
    onRetry: (error, attempt) => context.emit("warning", "当前 API Key 请求失败，正在切换下一个 Key", retryDetail(error, attempt)),
  });
  const results = provider === "gemini"
    ? await Promise.all(Array.from({ length: count }, () => request(1)))
    : [await request(count)];
  const images = results.flatMap((result) => result.images);
  if (images.length < count) throw new Error(`生图接口只返回 ${images.length}/${count} 张图片`);
  return { images: images.slice(0, count), provider };
}

export function createImageGenerationHandler(options: {
  settings: Pick<SettingsStorage, "get">;
  storyboards: StoryboardRepository;
  projects: ProjectRepository;
  characterProfiles?: CharacterProfileRepository;
  projectsRoot: string;
  keyPool?: ApiKeyPool;
}): JobHandler<ImageGenerationInput, {
  storyboardId: number;
  imagePath: string;
  imagePaths: string[];
  characterAssetPaths: string[];
  provider: string;
}> {
  const keyPool = options.keyPool ?? new ApiKeyPool();

  return async (rawInput: ImageGenerationInput, context: JobExecutionContext) => {
    const input = imageGenerationInput.parse(rawInput);
    const storyboard = options.storyboards.get(input.storyboardId);
    const project = options.projects.get(storyboard.projectId);
    const requestedProfile = input.characterProfileId && options.characterProfiles
      ? options.characterProfiles.get(input.characterProfileId)
      : null;
    if (input.characterProfileId && !options.characterProfiles) {
      throw new Error("当前运行环境没有启用项目角色档案仓储");
    }
    if (requestedProfile && requestedProfile.projectId !== project.id) {
      throw new Error(`角色档案 ${requestedProfile.id} 不属于分镜所在项目`);
    }
    const profiles = requestedProfile
      ? [requestedProfile]
      : options.characterProfiles?.resolve(project.id, storyboard.subjects) ?? [];
    const basePrompt = input.prompt?.trim()
      || (requestedProfile ? requestedProfile.prompt.trim() || requestedProfile.visualPrompt.trim() : storyboard.prompt.trim());
    const prompt = characterAssetPrompt(basePrompt, profiles);
    if (!prompt) throw new Error("分镜没有可用于生图的画面提示词");

    options.storyboards.markImageJob(storyboard.id, "generating", context.jobId);
    try {
      const count = input.count ?? 1;
      const { images, provider } = await requestGeneratedImages(
        { settings: options.settings, keyPool },
        { ...input, prompt },
        context,
      );

      context.updateProgress(72, "正在保存图片到本地");
      const projectDirectory = project.folderPath.trim() || join(options.projectsRoot, `project-${project.id}`);
      const configuredOutputRoot = options.settings.get("imagegen_output_dir")?.trim();
      const imageOutputDirectory = configuredOutputRoot
        ? join(configuredOutputRoot, `${safeDirectoryName(project.name)}-${project.id}`)
        : join(projectDirectory, "images");
      const imagePaths: string[] = [];
      const characterAssetPaths: string[] = [];
      try {
        for (const [index, image] of images.entries()) {
          imagePaths.push(await persistGeneratedImage({
            image,
            outputDirectory: imageOutputDirectory,
            stem: `storyboard-${storyboard.index + 1}-${index + 1}`,
            signal: context.signal,
          }));
          context.updateProgress(72 + Math.round((index + 1) / count * 18), `正在保存图片 ${index + 1}/${count}`);
        }
        if (profiles.length === 1 && imagePaths[0]) {
          characterAssetPaths.push(await persistCharacterAsset(
            imagePaths[0],
            projectDirectory,
            profiles[0].name,
          ));
        }
        if (imagePaths.length === 1) options.storyboards.attachGeneratedImage(storyboard.id, imagePaths[0], context.jobId);
        else options.storyboards.attachGeneratedImages(storyboard.id, imagePaths, context.jobId);
      } catch (attachError) {
        const cleanup = await Promise.allSettled(imagePaths.map((imagePath) => rm(imagePath, { force: true })));
        const cleanupErrors = cleanup.filter((result) => result.status === "rejected").map((result) => result.reason);
        if (cleanupErrors.length > 0) throw new AggregateError([attachError, ...cleanupErrors], "图片回写失败，且无法清理本次生成的文件");
        throw attachError;
      }
      const imagePath = imagePaths[0];
      context.updateProgress(95, "图片已保存并写入分镜", { storyboardId: storyboard.id, imagePaths });
      return { storyboardId: storyboard.id, imagePath, imagePaths, characterAssetPaths, provider };
    } catch (error) {
      options.storyboards.markImageJob(storyboard.id, "error", context.jobId);
      throw error;
    }
  };
}

export function createStandaloneImageGenerationHandler(options: {
  settings: Pick<SettingsStorage, "get">;
  projectsRoot: string;
  keyPool?: ApiKeyPool;
}): JobHandler<StandaloneImageGenerationInput, StandaloneImageGenerationOutput> {
  const keyPool = options.keyPool ?? new ApiKeyPool();
  return async (rawInput, context) => {
    const input = standaloneImageGenerationInput.parse(rawInput);
    const count = input.count ?? 1;
    const { images, provider } = await requestGeneratedImages(
      { settings: options.settings, keyPool },
      input,
      context,
    );
    const outputRoot = resolve(
      input.outputDirectory?.trim()
      || options.settings.get("imagegen_output_dir")?.trim()
      || join(options.projectsRoot, "independent-images"),
    );
    const outputDirectory = join(outputRoot, safeDirectoryName(input.batchName));
    const imagePaths: string[] = [];
    try {
      context.updateProgress(72, "正在保存图片到独立目录");
      for (const [index, image] of images.entries()) {
        imagePaths.push(await persistGeneratedImage({
          image,
          outputDirectory,
          stem: index === 0 ? input.name : `${input.name}-${index + 1}`,
          replaceExisting: true,
          signal: context.signal,
        }));
        context.updateProgress(72 + Math.round((index + 1) / count * 20), `正在保存图片 ${index + 1}/${count}`);
      }
      context.updateProgress(96, "图片已保存到独立目录", { imagePaths });
      return { imagePath: imagePaths[0], imagePaths, outputDirectory, provider };
    } catch (error) {
      await Promise.allSettled(imagePaths.map((imagePath) => rm(imagePath, { force: true })));
      throw error;
    }
  };
}
