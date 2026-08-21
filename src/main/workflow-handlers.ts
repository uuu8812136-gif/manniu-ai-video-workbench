import { z } from "zod";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { WorkflowJobType } from "../shared/contracts";
import { originalStoryboardDuration } from "../shared/storyboard-duration";
import { ApiKeyPool, parseApiKeys } from "./api-key-pool";
import {
  createImageGenerationHandler,
  createStandaloneImageGenerationHandler,
  imageGenerationInput,
  standaloneImageGenerationInput,
} from "./image-workflow";
import { videoGenerationInput } from "./video-workflow";
import { PersistentJobQueue, type JobExecutionContext } from "./jobs";
import { ModelApiError, OpenAIModelClient, type TextModelResult } from "./model-clients";
import { preflightFileAgentModel } from "./agent-model-preflight";
import { CharacterProfileRepository, ProjectRepository, StoryboardRepository } from "./repositories";
import type { SettingsStorage } from "./secure-settings";
import { atomicWriteFile, writeCsvFileAtomic, writeTextFileAtomic } from "./file-workflows";
import { inferenceRuntimePaths } from "./inference-runtime";
import { runOriginalInference } from "./original-inference";
import { runOriginalAgentInference } from "./original-agent-inference";
import { runOriginalAgentOpening } from "./original-agent-opening";
import { loadOriginalOpeningSystem, validateOriginalOpeningDraft } from "./opening-runtime";
import { ORIGINAL_POLISH_INSTRUCTIONS } from "./original-polish-prompt";
import {
  buildOpeningPrompt,
  finalizeOpeningOutput,
  formatCharacterRoster,
  missingCharacterProfiles,
} from "./workflow-prompts";

const sourceText = z.string().min(1).max(2_000_000).refine((value) => value.trim().length > 0, "文案内容为空");

export const ADVANCED_POLISH_INSTRUCTIONS = `你是中文小说文案编辑。请在不改变人物关系、关键事实、事件因果和结局的前提下，输出一份可直接用于配音的完整成稿。

要求：
1. 可以重组句序、合并重复表达并补足必要的过渡，使叙事更顺畅。
2. 强化冲突、悬念、情绪递进和口语节奏，但不得虚构原文不存在的事件、设定或人物动机。
3. 保留原文的重要细节、称谓和时间顺序；发现矛盾时采用最保守且不新增事实的表述。
4. 删除标题说明、编辑批注和无意义重复，不要输出分析过程、修改说明或 Markdown 代码块。
5. 只输出润色后的完整正文。`;

export const openingInput = z.object({
  text: sourceText,
  title: z.string().trim().max(160).optional(),
  mode: z.enum(["general", "enhanced", "rewrite", "variants"]).optional(),
  outDir: z.string().trim().min(1).max(32_767).optional(),
});

export const polishInput = z.object({
  text: sourceText,
  title: z.string().trim().max(160).optional(),
  outDir: z.string().trim().min(1).max(32_767).optional(),
  mode: z.enum(["original", "advanced"]).optional(),
  sourceFormat: z.enum(["txt", "docx"]).optional(),
});

export const storyboardInput = z.object({
  text: sourceText,
  genre: z.string().trim().max(80).optional(),
  projectId: z.number().int().positive().optional(),
});

export function parseWorkflowInput(type: WorkflowJobType, input: unknown): unknown {
  if (type === "opening.optimize") return openingInput.parse(input);
  if (type === "text.polish") return polishInput.parse(input);
  if (type === "storyboard.infer") return storyboardInput.parse(input);
  if (type === "image.generate") return imageGenerationInput.parse(input);
  if (type === "image.standalone") return standaloneImageGenerationInput.parse(input);
  if (type === "video.generate") return videoGenerationInput.parse(input);
  throw new Error(`工作流尚未注册: ${type}`);
}

function requiredSetting(settings: Pick<SettingsStorage, "get">, key: string, label: string): string {
  const value = settings.get(key)?.trim();
  if (!value) throw new Error(`请先在设置中配置${label}`);
  return value;
}

function clientFrom(settings: Pick<SettingsStorage, "get">, prefix: "infer" | "text_polish"): {
  model: string;
  protocol: "responses" | "chat";
} {
  const model = requiredSetting(settings, `${prefix}_model`, "模型");
  const protocolValue = settings.get(`${prefix}_protocol`)?.trim();
  return {
    model,
    protocol: protocolValue === "chat" ? "chat" : "responses",
  };
}

function retryDetail(error: unknown, attempt: number): Record<string, unknown> {
  return error instanceof ModelApiError
    ? { attempt, kind: error.kind, status: error.status ?? null, requestId: error.requestId ?? null }
    : { attempt };
}

function canSwitchAgentKey(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b(?:401|403|429|5\d\d)\b|authentication|unauthorized|forbidden|rate.?limit|timeout|timed.?out|network|socket|econn|鉴权|认证|限流|超时|网络|上游)/iu.test(message);
}

function inferAgentConfiguration(settings: Pick<SettingsStorage, "get">): {
  baseUrl: string;
  model: string;
  keys: string[];
  concurrencyPerKey: number;
} {
  const keys = parseApiKeys(settings.get("infer_api_key"), settings.get("infer_api_keys"));
  if (keys.length === 0) throw new Error("请先在设置中配置小说转分镜 API Key");
  return {
    baseUrl: requiredSetting(settings, "infer_api_base_url", "小说转分镜 API 地址"),
    model: requiredSetting(settings, "infer_model", "小说转分镜模型"),
    keys,
    concurrencyPerKey: Number(settings.get("infer_concurrency_per_key")) || 2,
  };
}

function integerSetting(
  settings: Pick<SettingsStorage, "get">,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(settings.get(key));
  if (!Number.isInteger(value) || value < minimum || value > maximum) return fallback;
  return value;
}

function requestedOutputTokens(
  settings: Pick<SettingsStorage, "get">,
  prefix: "infer" | "text_polish",
  requested: number | undefined,
): number | undefined {
  if (!requested) return undefined;
  const configured = Number(settings.get(`${prefix}_max_output_tokens`));
  if (!Number.isInteger(configured) || configured <= 0 || configured > 1_000_000) return requested;
  return Math.min(requested, configured);
}

function streamProgress(
  context: JobExecutionContext,
  progressStart = 10,
  progressEnd = 70,
): (progress: {
  reasoningCharacters: number;
  textCharacters: number;
  reasoningDelta: string;
  textDelta: string;
}) => void {
  let lastProgress = progressStart;
  return ({ reasoningCharacters, textCharacters, textDelta }) => {
    const span = Math.max(1, progressEnd - progressStart);
    const phase = textCharacters > 0
      ? 0.45 + Math.min(0.5, Math.log10(textCharacters + 1) / 10)
      : 0.1 + Math.min(0.3, Math.log10(reasoningCharacters + 1) / 12);
    const next = Math.min(progressEnd, progressStart + Math.floor(span * phase));
    if (next <= lastProgress) return;
    lastProgress = next;
    context.updateProgress(
      next,
      textCharacters > 0 ? "正在生成结果正文" : "模型正在分析内容",
      { progress: next, reasoningCharacters, textCharacters, receivedCharacters: textDelta.length },
    );
  };
}

async function runTextModel(
  settings: Pick<SettingsStorage, "get">,
  prefix: "infer" | "text_polish",
  prompt: string | {
    system?: string;
    user: string;
    progressStart?: number;
    progressEnd?: number;
    maxOutputTokens?: number;
  },
  context: JobExecutionContext,
  keyPool: ApiKeyPool,
): Promise<TextModelResult> {
  const request = typeof prompt === "string" ? { user: prompt } : prompt;
  const progressStart = request.progressStart ?? 10;
  const progressEnd = request.progressEnd ?? 70;
  const { model, protocol } = clientFrom(settings, prefix);
  const baseUrl = requiredSetting(settings, `${prefix}_api_base_url`, " API 地址");
  const keys = parseApiKeys(settings.get(`${prefix}_api_key`), settings.get(`${prefix}_api_keys`));
  const concurrency = Number(settings.get(`${prefix}_concurrency_per_key`)) || 2;
  const timeoutMs = integerSetting(
    settings,
    `${prefix}_timeout_ms`,
    prefix === "infer" ? 150_000 : 1_800_000,
    10_000,
    7_200_000,
  );
  const streamInactivityTimeoutMs = integerSetting(
    settings,
    `${prefix}_stream_inactivity_timeout_ms`,
    prefix === "infer" ? 150_000 : 120_000,
    10_000,
    600_000,
  );
  const configuredThinking = settings.get(`${prefix}_thinking`)?.trim().toLowerCase();
  const thinking = prefix === "infer" && (!configuredThinking || configuredThinking === "auto")
    ? "disabled"
    : configuredThinking;
  const maxOutputTokens = requestedOutputTokens(settings, prefix, request.maxOutputTokens);
  context.updateProgress(progressStart, "正在连接模型");
  return keyPool.run({
    keys,
    concurrencyPerKey: concurrency,
    maxAttemptsPerKey: prefix === "infer" ? 3 : 1,
    signal: context.signal,
    operation: (apiKey) => {
      const client = new OpenAIModelClient({ baseUrl, apiKey, timeoutMs, streamInactivityTimeoutMs });
      if (protocol === "chat") {
        const request: Parameters<OpenAIModelClient["chatCompletions"]>[0] = {
          model,
          messages: [
            ...(typeof prompt !== "string" && prompt.system
              ? [{ role: "system" as const, content: prompt.system }]
              : []),
            { role: "user", content: typeof prompt === "string" ? prompt : prompt.user },
          ],
          stream: true,
          stream_options: { include_usage: true },
        };
        if (maxOutputTokens) request.max_tokens = maxOutputTokens;
        if (thinking === "disabled" || thinking === "enabled") request.thinking = { type: thinking };
        return client.chatCompletions(
          request,
          {
            signal: context.signal,
            timeoutMs,
            streamInactivityTimeoutMs,
            onStream: streamProgress(context, progressStart, progressEnd),
          },
        );
      }
      context.updateProgress(Math.min(progressEnd, progressStart + 1), "模型正在分析小说");
      return client.responses({
        model,
        input: request.user,
        stream: true,
        ...(request.system ? { instructions: request.system } : {}),
        ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
      }, { signal: context.signal, timeoutMs });
    },
    onRetry: (error, attempt, state) => context.emit(
      "warning",
      state.switchingKey ? "当前 API Key 请求失败，正在切换下一个 Key" : "模型请求暂时失败，正在重试当前 Key",
      { ...retryDetail(error, attempt), keyAttempt: state.keyAttempt, maxAttemptsPerKey: state.maxAttemptsPerKey },
    ),
  });
}

async function materializeLegacyArtifacts(result: Awaited<ReturnType<typeof runOriginalInference>>): Promise<void> {
  const roster = formatCharacterRoster(result.characters);
  await Promise.all([
    writeTextFileAtomic(result.artifacts.rosterPath, roster),
    writeTextFileAtomic(
      result.artifacts.sentencesPath,
      `${result.storyboards.map((storyboard) => storyboard.originalText).join("\r\n")}\r\n`,
    ),
    writeCsvFileAtomic(
      result.artifacts.csvPath,
      result.storyboards.map((storyboard, index) => ({
        编号: String(index + 1),
        原声: storyboard.originalText,
        秒数: String(originalStoryboardDuration(storyboard.originalText)),
        画面提示词: storyboard.prompt ?? "",
      })),
      { columns: ["编号", "原声", "秒数", "画面提示词"], bom: true },
    ),
  ]);
}

async function copyInferenceArtifact(source: string, destination: string): Promise<void> {
  await atomicWriteFile(destination, await readFile(source));
}

function safeTextOutputName(value: string, fallback = "未命名小说"): string {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 160);
  return sanitized || fallback;
}

type WorkflowHandlerOptions = {
  projects: ProjectRepository;
  projectsRoot: string;
  documentsRoot?: string;
  characterProfiles?: CharacterProfileRepository;
  inferenceResourcesRoot?: string;
  allowLegacyInferenceFastPath?: boolean;
};

export function registerWorkflowHandlers(
  queue: PersistentJobQueue,
  settings: Pick<SettingsStorage, "get">,
  storyboards: StoryboardRepository,
  imageOptions?: WorkflowHandlerOptions,
): void {
  const textKeyPool = new ApiKeyPool();
  queue.register("opening.optimize", async (rawInput, context) => {
    const input = openingInput.parse(rawInput);
    const mode = input.mode ?? "general";
    const prefix = "infer" as const;
    const originalMode = mode === "general" || mode === "enhanced" ? mode : null;
    const outputDirectory = input.outDir
      ?? settings.get("opening_output_dir")?.trim()
      ?? imageOptions?.documentsRoot
      ?? imageOptions?.projectsRoot
      ?? process.cwd();
    let result: TextModelResult;
    if (originalMode && !(imageOptions?.allowLegacyInferenceFastPath ?? false)) {
      const agent = inferAgentConfiguration(settings);
      const opening = await textKeyPool.run({
        keys: agent.keys,
        concurrencyPerKey: agent.concurrencyPerKey,
        signal: context.signal,
        maxAttemptsPerKey: 1,
        canRetry: canSwitchAgentKey,
        operation: async (apiKey) => {
          context.updateProgress(3, "正在验证 DeepSeek 模型和 API Key");
          await preflightFileAgentModel({ baseUrl: agent.baseUrl, apiKey: apiKey!, model: agent.model });
          return runOriginalAgentOpening({
            mode: originalMode,
            source: input.text,
            resourcesRoot: imageOptions?.inferenceResourcesRoot ?? join(process.cwd(), "vendor"),
            workRoot: join(outputDirectory, ".ai-tool-opening", context.jobId),
            baseUrl: agent.baseUrl,
            apiKey: apiKey!,
            model: agent.model,
            context,
          });
        },
        onRetry: (error, attempt) => context.emit(
          "warning",
          "当前 API Key 的开头 Agent 任务失败，正在切换下一个 Key",
          { ...retryDetail(error, attempt), attempt },
        ),
      });
      result = {
        text: opening.draft,
        id: null,
        model: opening.model,
        usage: opening.runtime,
        raw: { attempts: opening.attempts, repairRounds: opening.repairRounds },
      };
    } else {
      const system = originalMode
        ? await loadOriginalOpeningSystem(imageOptions?.inferenceResourcesRoot ?? join(process.cwd(), "vendor"), originalMode, input.text)
        : undefined;
      result = await runTextModel(
        settings,
        prefix,
        system
          ? {
              system,
              user: buildOpeningPrompt(input.text, mode, input.title),
              progressStart: 8,
              progressEnd: 78,
              maxOutputTokens: originalMode === "enhanced" ? 32_768 : 16_384,
            }
          : buildOpeningPrompt(input.text, mode, input.title),
        context,
        textKeyPool,
      );
    }
    if (originalMode && (imageOptions?.allowLegacyInferenceFastPath ?? false)) {
      const system = await loadOriginalOpeningSystem(
        imageOptions?.inferenceResourcesRoot ?? join(process.cwd(), "vendor"),
        originalMode,
        input.text,
      );
      const errors = validateOriginalOpeningDraft(result.text, originalMode, input.text);
      if (errors.length > 0) {
        context.emit("warning", "开头产物未通过原版硬校验，正在修复", { errors });
        result = await runTextModel(
          settings,
          prefix,
          {
            system: system!,
            user: [
              "上一次 output_kaitou.txt 未通过程序硬校验。只修复下列问题，并重新输出完整文件内容，不要解释。",
              ...errors.map((error) => `- ${error}`),
              "上一次产物：",
              result.text,
              "原文（只用于核对事实和增强版衔接锚点，不得整体复制）：",
              input.text,
            ].join("\n"),
            progressStart: 79,
            progressEnd: 93,
            maxOutputTokens: originalMode === "enhanced" ? 32_768 : 16_384,
          },
          context,
          textKeyPool,
        );
        const repairedErrors = validateOriginalOpeningDraft(result.text, originalMode, input.text);
        if (repairedErrors.length > 0) {
          throw new Error(`开头产物校验未通过：${repairedErrors.join("；")}`);
        }
      }
    }
    context.updateProgress(95, "正在保存结果");
    const text = mode === "rewrite" ? result.text : finalizeOpeningOutput(result.text, input.text);
    const outputPath = await writeTextFileAtomic(join(outputDirectory, "output_kaitou.txt"), text);
    return {
      text,
      content: text,
      outputPath,
      outDir: outputDirectory,
      model: result.model,
      usage: result.usage,
    };
  });

  queue.register("text.polish", async (rawInput, context) => {
    const input = polishInput.parse(rawInput);
    const mode = input.mode ?? "original";
    const result = await runTextModel(
      settings,
      "text_polish",
      { system: mode === "advanced" ? ADVANCED_POLISH_INSTRUCTIONS : ORIGINAL_POLISH_INSTRUCTIONS, user: input.text },
      context,
      textKeyPool,
    );
    context.updateProgress(95, "正在保存结果");
    const outputDirectory = input.outDir
      ?? settings.get("text_polish_output_dir")?.trim()
      ?? join(imageOptions?.documentsRoot ?? imageOptions?.projectsRoot ?? process.cwd(), "AI工具捋文");
    const outputPath = await writeTextFileAtomic(
      join(outputDirectory, `${safeTextOutputName(input.title ?? "")}_捋文.txt`),
      result.text,
    );
    return { text: result.text, content: result.text, outputPath, mode, model: result.model, usage: result.usage };
  });

  queue.register("storyboard.infer", async (rawInput, context) => {
    const input = storyboardInput.parse(rawInput);
    const project = input.projectId && imageOptions ? imageOptions.projects.get(input.projectId) : null;
    const outputDirectory = project && imageOptions
      ? (project.folderPath.trim() || join(imageOptions.projectsRoot, `project-${project.id}`))
      : join(imageOptions?.projectsRoot ?? process.cwd(), "inference-output");
    const workDir = join(outputDirectory, ".ai-tool-inference", context.jobId);
    context.emit("info", "推理恢复目录已准备", { workDir });
    const resourcesRoot = imageOptions?.inferenceResourcesRoot ?? join(process.cwd(), "vendor");
    const runtime = inferenceRuntimePaths(resourcesRoot);
    const inference = imageOptions?.allowLegacyInferenceFastPath
      ? await runOriginalInference({
          text: input.text,
          title: project?.name ?? `推理-${context.jobId.slice(0, 8)}`,
          genre: input.genre ?? "自动判断",
          workDir,
          runtime,
          context,
          allowLegacyFastPath: true,
          callModel: (request) => runTextModel(
            settings,
            "infer",
            {
              system: request.system,
              user: request.user,
              progressStart: request.progressStart,
              progressEnd: request.progressEnd,
              maxOutputTokens: request.maxOutputTokens,
            },
            context,
            textKeyPool,
          ),
        })
      : await (async () => {
          const agent = inferAgentConfiguration(settings);
          return textKeyPool.run({
            keys: agent.keys,
            concurrencyPerKey: agent.concurrencyPerKey,
            signal: context.signal,
            maxAttemptsPerKey: 1,
            canRetry: canSwitchAgentKey,
            operation: async (apiKey) => {
              context.updateProgress(3, "正在验证 DeepSeek 模型和 API Key");
              await preflightFileAgentModel({ baseUrl: agent.baseUrl, apiKey: apiKey!, model: agent.model });
              return runOriginalAgentInference({
                text: input.text,
                title: project?.name ?? `推理-${context.jobId.slice(0, 8)}`,
                genre: input.genre ?? "自动判断",
                workDir,
                runtime,
                agent: {
                  claudePath: join(resourcesRoot, "claude", "bin", "claude.exe"),
                  baseUrl: agent.baseUrl,
                  apiKey: apiKey!,
                  model: agent.model,
                },
                context,
              });
            },
            onRetry: (error, attempt) => context.emit(
              "warning",
              "当前 API Key 的文件 Agent 推理失败，正在切换下一个 Key",
              { ...retryDetail(error, attempt), attempt, workDir },
            ),
          });
        })();
    if (inference.legacyFastPath) await materializeLegacyArtifacts(inference);
    context.updateProgress(93, "正在校验分镜结构");
    const drafts = inference.storyboards.map((storyboard) => ({
      ...storyboard,
      duration: originalStoryboardDuration(storyboard.originalText),
    }));
    const missingProfiles = missingCharacterProfiles(inference.characters, drafts);
    if (missingProfiles.length > 0) {
      throw new Error(`模型缺少角色档案或角色推理词：${missingProfiles.join("、")}。请重试小说推理。`);
    }
    let artifacts: { rosterPath: string; csvPath: string; sentencesPath: string; workDir: string } | null = null;
    if (project && imageOptions) {
      const rosterPath = join(outputDirectory, "角色表.txt");
      const csvPath = join(outputDirectory, inference.artifacts.csvPath.split(/[\\/]/u).at(-1) ?? "分镜.csv");
      const sentencesPath = join(outputDirectory, inference.artifacts.sentencesPath.split(/[\\/]/u).at(-1) ?? "分句.txt");
      context.updateProgress(95, "正在提交原版角色表、四列 CSV 和分句文件", {
        characters: inference.characters.length,
        storyboards: drafts.length,
      });
      await Promise.all([
        copyInferenceArtifact(inference.artifacts.rosterPath, rosterPath),
        copyInferenceArtifact(inference.artifacts.csvPath, csvPath),
        copyInferenceArtifact(inference.artifacts.sentencesPath, sentencesPath),
      ]);
      artifacts = { rosterPath, csvPath, sentencesPath, workDir };
    }
    const output: Record<string, unknown> = {
      characters: inference.characters,
      storyboards: drafts,
      artifacts,
      model: inference.model,
      usage: inference.usage,
      stages: inference.stages,
      legacyFastPath: inference.legacyFastPath,
    };
    if (project && artifacts && imageOptions) {
      context.complete(output, () => {
        const persisted = storyboards.replace(project.id, drafts);
        imageOptions.characterProfiles?.replace(project.id, inference.characters.map((character) => ({
          ...character,
          prompt: character.visualPrompt,
        })));
        imageOptions.projects.update(project.id, { csvPath: artifacts.csvPath, rosterPath: artifacts.rosterPath });
        output.storyboards = persisted;
      });
    }
    return output;
  });

  if (imageOptions) {
    queue.register(
      "image.generate",
      createImageGenerationHandler({ settings, storyboards, ...imageOptions }),
    );
    queue.register(
      "image.standalone",
      createStandaloneImageGenerationHandler({ settings, projectsRoot: imageOptions.projectsRoot }),
    );
  }
}
