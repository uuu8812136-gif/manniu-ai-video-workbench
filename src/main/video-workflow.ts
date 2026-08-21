import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { VideoProvider, VideoRecoveryState, ViduAccount, ViduAccountStatus, ViduModel } from "../shared/contracts";
import { ApiKeyPool, parseApiKeys } from "./api-key-pool";
import type { JobExecutionContext, JobHandler, PersistentJobQueue } from "./jobs";
import {
  CharacterProfileRepository,
  ProjectRepository,
  StoryboardRepository,
  ViduAccountRepository,
} from "./repositories";
import type { SettingsStorage } from "./secure-settings";
import { bindViduSubjects, extractViduRoleNames, type ViduGenerationClient } from "./vidu-protocol";
import { preflightCharacterAssets } from "./character-assets";
import {
  AsyncVideoTaskClient,
  VideoApiError,
  type CompletedVideoTask,
  type VideoTaskClientOptions,
  type VideoTaskStatus,
} from "./video-client";

export const videoGenerationInput = z
  .object({
    storyboardId: z.number().int().positive(),
    provider: z.enum(["custom-api", "vidu-browser"]).optional(),
    accountId: z.string().uuid().optional(),
    viduModel: z.enum(["Q2", "Q3"]).optional(),
    q3PreCount: z.number().int().min(0).max(9_999).optional(),
    useCredits: z.boolean().optional(),
    prompt: z.string().trim().max(20_000).optional(),
    durationSeconds: z.number().int().positive().max(300).optional(),
    aspectRatio: z.string().trim().max(40).optional(),
    imageUrl: z.string().trim().url().max(32_767).optional(),
    parameters: z.record(z.string().max(120), z.unknown()).optional(),
  })
  .strict();

export type VideoGenerationInput = z.infer<typeof videoGenerationInput>;

export type VideoGenerationOutput = {
  storyboardId: number;
  provider: VideoProvider;
  accountId: string | null;
  providerTaskId: string;
  videoPath: string;
  model: string;
  bytes: number;
};

export function viduModelForStoryboard(
  storyboardIndex: number,
  input: Pick<VideoGenerationInput, "q3PreCount" | "viduModel">,
  configuredModel: ViduModel,
): ViduModel {
  if (input.q3PreCount !== undefined) {
    return input.q3PreCount === 0 || storyboardIndex < input.q3PreCount ? "Q3" : "Q2";
  }
  return input.viduModel ?? configuredModel;
}

type VideoClientFactory = (options: VideoTaskClientOptions) => AsyncVideoTaskClient;
type GenerationClient = Pick<ViduGenerationClient, "waitForResult" | "downloadResult">;
type ViduAccountDispatchMode = "sequential" | "parallel";
type ViduBrowserAccess = {
  checkLogin(account: ViduAccount): Promise<ViduAccountStatus>;
  client(account: ViduAccount): ViduGenerationClient;
  openLogin?(account: ViduAccount): Promise<void>;
};

function required(settings: Pick<SettingsStorage, "get">, key: string, label: string): string {
  const value = settings.get(key)?.trim();
  if (!value) throw new Error(`请先在设置中配置${label}`);
  return value;
}

function optionalInteger(
  settings: Pick<SettingsStorage, "get">,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(settings.get(key));
  return Number.isFinite(parsed) && parsed >= minimum ? Math.min(Math.round(parsed), maximum) : fallback;
}

function booleanSetting(value: string | null, fallback = false): boolean {
  if (value === null || !value.trim()) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function providerSetting(value: string | null): VideoProvider {
  return value?.trim() === "vidu-browser" ? "vidu-browser" : "custom-api";
}

function modelSetting(value: string | null): ViduModel {
  return value?.trim().toUpperCase() === "Q2" ? "Q2" : "Q3";
}

function viduAccountDispatchMode(value: string | null): ViduAccountDispatchMode {
  return value?.trim().toLowerCase() === "parallel" ? "parallel" : "sequential";
}

function canTryAnotherVideoKey(error: unknown): boolean {
  return error instanceof VideoApiError
    && ["authentication", "rate_limit", "server", "network", "timeout"].includes(error.kind);
}

function retryDetail(error: unknown, attempt: number): Record<string, unknown> {
  return error instanceof VideoApiError
    ? { attempt, kind: error.kind, status: error.status ?? null, requestId: error.requestId ?? null }
    : { attempt };
}

function isExplicitCancellation(signal: AbortSignal): boolean {
  const reason = signal.reason;
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  return /cancelled|canceled/i.test(message);
}

function taskProgress(status: VideoTaskStatus): number {
  if (status.progress !== null) return Math.min(76, 15 + Math.round(status.progress * 0.61));
  return status.phase === "running" ? 36 : 18;
}

function emitPollProgress(context: JobExecutionContext, status: VideoTaskStatus): void {
  context.updateProgress(taskProgress(status), "视频模型正在生成", {
    providerStatus: status.providerStatus,
    progress: status.progress,
  });
}

export function viduAccountHasCapacity(account: ViduAccount, useCredits: boolean, reserved = 0): boolean {
  if (account.accountType === "points") return true;
  const committedUsage = account.usageCount + Math.max(0, reserved);
  return useCredits || committedUsage < account.defaultQuota;
}

function isViduCreditsError(error: unknown): boolean {
  return error instanceof VideoApiError
    && error.kind === "rate_limit"
    && /额度|积分不足|quota|CreditNotEnough|CreditsNotEnough|CreditNotAvailable|CreditsNotAvailable|NotEnoughCredits?|InsufficientCredits?|InsufficientBalance|BalanceInsufficient|CreditBalanceInsufficient|QuotaExceeded|QuotaExhausted|credits?\s*insufficient/i.test(error.message);
}

function isViduPlanLimitError(error: unknown): boolean {
  return error instanceof VideoApiError
    && error.kind === "rate_limit"
    && /NonPeakTaskSubmitLimitExceeded|SubPlanNotSupportedForTask/i.test(error.message);
}

function isConfirmedViduAuthenticationError(error: unknown): error is VideoApiError {
  return error instanceof VideoApiError
    && error.kind === "authentication"
    && (error.status === 401 || error.status === 403);
}

function recoveryStateForError(error: unknown, current: VideoRecoveryState): VideoRecoveryState {
  if (error instanceof VideoApiError) {
    if (error.kind === "provider_failed") return "failed";
    if (error.kind === "download") return "download_failed";
    if (error.kind === "not_found") return "not_found";
    if (error.kind === "timeout" && current === "waiting_url") return "waiting_url";
  }
  return "unavailable";
}

type ViduAccountLease = {
  account: ViduAccount;
  reject(): void;
  release(): void;
};

class ViduAccountChannelPool {
  private nextAccountIndex = 0;
  private cursorInitialized = false;
  private sequentialAccountId: string | null = null;
  private readonly reservations = new Map<string, number>();
  private readonly busyAccounts = new Set<string>();
  private readonly subjectCooldowns = new Map<string, { until: number; message: string }>();
  private readonly creditsRejectedAccounts = new Map<string, string>();
  private lockTail = Promise.resolve();
  private changeVersion = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly accounts: ViduAccountRepository,
    private readonly browser: ViduBrowserAccess,
  ) {}

  private notifyStateChanged(): void {
    this.changeVersion += 1;
    const waiters = this.waiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }

  deferSubjectLimited(accountId: string, message: string, cooldownMs = 5 * 60_000): void {
    this.subjectCooldowns.set(accountId, { until: Date.now() + cooldownMs, message });
    this.notifyStateChanged();
  }

  deferCreditsRejected(accountId: string, message: string): void {
    this.creditsRejectedAccounts.set(accountId, message);
    this.notifyStateChanged();
  }

  async acquire(input: {
    requestedId?: string;
    allowFallback: boolean;
    useCredits: boolean;
    dispatchMode: ViduAccountDispatchMode;
    excludedIds?: Set<string>;
    signal: AbortSignal;
  }): Promise<ViduAccountLease> {
    const unavailableForAttempt = new Set(input.excludedIds ?? []);
    for (;;) {
      const result = await this.withLock(async () => this.tryReserve({
        ...input,
        excludedIds: unavailableForAttempt,
      }));
      if (!("lease" in result)) {
        await this.waitForChange(result.version, input.signal);
        continue;
      }
      const lease = result.lease;
      try {
        const status = await this.browser.checkLogin(lease.account);
        if (status.status === "logged-in") return lease;
        if (status.status === "logged-out") {
          this.accounts.markLoginExpired(lease.account.id, status.message);
          lease.reject();
          if (input.allowFallback) continue;
          throw new Error(`账号池没有可用账号：${lease.account.name} ${status.message}`);
        }
        lease.release();
        if (input.allowFallback) {
          unavailableForAttempt.add(lease.account.id);
          continue;
        }
        throw new Error(`当前账号“${lease.account.name}”登录状态暂时无法确认：${status.message}`);
      } catch (error) {
        lease.release();
        throw error;
      }
    }
  }

  private tryReserve(input: {
    requestedId?: string;
    allowFallback: boolean;
    useCredits: boolean;
    dispatchMode: ViduAccountDispatchMode;
    excludedIds?: Set<string>;
  }): { lease: ViduAccountLease } | { version: number } {
    const ordered = this.accounts.list();
    if (ordered.length === 0) throw new Error("请先在设置中添加并登录 Vidu 账号");
    const now = Date.now();
    for (const [accountId, cooldown] of this.subjectCooldowns) {
      if (cooldown.until <= now) this.subjectCooldowns.delete(accountId);
    }

    if (!input.allowFallback && input.requestedId) {
      const requested = ordered.find((account) => account.id === input.requestedId);
      if (!requested) throw new Error(`Vidu 账号不存在: ${input.requestedId}`);
      if (!requested.enabled) throw new Error(`账号池没有可用账号：${requested.name} 已停用`);
      if (this.creditsRejectedAccounts.has(requested.id)) {
        throw new Error(`账号池没有可用账号：${requested.name} 本次运行已返回积分不足，重启程序后会重新检测`);
      }
      const cooldown = this.subjectCooldowns.get(requested.id);
      if (cooldown) {
        throw new Error(`账号池没有可用账号：${requested.name} 主体库冷却中（约 ${Math.max(1, Math.ceil((cooldown.until - now) / 60_000))} 分钟）`);
      }
      if (!viduAccountHasCapacity(requested, input.useCredits, this.reservations.get(requested.id) ?? 0)) {
        throw new Error(`账号池没有可用账号：${requested.name} 额度已用完`);
      }
      return this.busyAccounts.has(requested.id)
        ? { version: this.changeVersion }
        : { lease: this.reserve(requested) };
    }

    if (input.dispatchMode === "sequential") {
      const requestedIndex = input.requestedId
        ? ordered.findIndex((account) => account.id === input.requestedId)
        : -1;
      const activeIndex = this.sequentialAccountId
        ? ordered.findIndex((account) => account.id === this.sequentialAccountId)
        : -1;
      const startIndex = activeIndex >= 0 ? activeIndex : requestedIndex >= 0 ? requestedIndex : 0;
      const errors: string[] = [];
      for (let checked = 0; checked < ordered.length; checked += 1) {
        const account = ordered[(startIndex + checked) % ordered.length];
        if (input.excludedIds?.has(account.id)) {
          errors.push(`${account.name} 本轮已确认不可用`);
          continue;
        }
        if (!account.enabled) {
          errors.push(`${account.name} 已停用`);
          continue;
        }
        if (this.creditsRejectedAccounts.has(account.id)) {
          errors.push(`${account.name} 本次运行已返回积分不足`);
          continue;
        }
        const cooldown = this.subjectCooldowns.get(account.id);
        if (cooldown) {
          errors.push(`${account.name} 主体库冷却中`);
          continue;
        }
        if (!viduAccountHasCapacity(account, input.useCredits, this.reservations.get(account.id) ?? 0)) {
          errors.push(`${account.name} 额度已用完`);
          continue;
        }
        this.sequentialAccountId = account.id;
        return this.busyAccounts.has(account.id)
          ? { version: this.changeVersion }
          : { lease: this.reserve(account) };
      }
      throw new Error(`账号池没有可用账号${errors.length > 0 ? `：${errors.join("；")}` : ""}`);
    }

    if (!this.cursorInitialized) {
      const requestedIndex = input.requestedId
        ? ordered.findIndex((account) => account.id === input.requestedId)
        : -1;
      this.nextAccountIndex = requestedIndex >= 0 ? requestedIndex : 0;
      this.cursorInitialized = true;
    }

    const errors: string[] = [];
    let hasBusyCandidate = false;
    for (let checked = 0; checked < ordered.length; checked += 1) {
      const accountIndex = (this.nextAccountIndex + checked) % ordered.length;
      const account = ordered[accountIndex];
      if (input.excludedIds?.has(account.id)) {
        errors.push(`${account.name} 本轮已确认不可用`);
        continue;
      }
      if (!account.enabled) {
        errors.push(`${account.name} 已停用`);
        continue;
      }
      if (this.creditsRejectedAccounts.has(account.id)) {
        errors.push(`${account.name} 本次运行已返回积分不足`);
        continue;
      }
      const cooldown = this.subjectCooldowns.get(account.id);
      if (cooldown) {
        errors.push(`${account.name} 主体库冷却中`);
        continue;
      }
      if (!viduAccountHasCapacity(account, input.useCredits, this.reservations.get(account.id) ?? 0)) {
        errors.push(`${account.name} 额度已用完`);
        continue;
      }
      if (this.busyAccounts.has(account.id)) {
        hasBusyCandidate = true;
        continue;
      }

      this.nextAccountIndex = (accountIndex + 1) % ordered.length;
      return { lease: this.reserve(account) };
    }
    if (hasBusyCandidate) return { version: this.changeVersion };
    throw new Error(`账号池没有可用账号${errors.length > 0 ? `：${errors.join("；")}` : ""}`);
  }

  private reserve(account: ViduAccount): ViduAccountLease {
    this.reservations.set(account.id, (this.reservations.get(account.id) ?? 0) + 1);
    this.busyAccounts.add(account.id);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.decrement(this.reservations, account.id);
      this.busyAccounts.delete(account.id);
      this.notifyStateChanged();
    };
    return {
      account,
      reject: release,
      release,
    };
  }

  private decrement(map: Map<string, number>, accountId: string): void {
    const next = (map.get(accountId) ?? 1) - 1;
    if (next > 0) map.set(accountId, next);
    else map.delete(accountId);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lockTail;
    let unlock!: () => void;
    this.lockTail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
    }
  }

  private waitForChange(version: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (version !== this.changeVersion) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = (): void => {
        const index = this.waiters.indexOf(finish);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      this.waiters.push(finish);
      signal.addEventListener("abort", abort, { once: true });
      if (version !== this.changeVersion) {
        const index = this.waiters.indexOf(finish);
        if (index >= 0) this.waiters.splice(index, 1);
        finish();
      }
    });
  }
}

async function locateViduRecoveryAccount(
  accounts: ViduAccountRepository,
  browser: ViduBrowserAccess,
  taskId: string,
  requestedId: string | undefined,
  signal: AbortSignal,
): Promise<{ account: ViduAccount; client: ViduGenerationClient; status: VideoTaskStatus }> {
  const ordered = accounts.list();
  const requested = requestedId
    ? ordered.find((account) => account.id === requestedId) ?? null
    : null;
  const candidates = [
    ...(requested ? [requested] : []),
    ...ordered.filter((account) => account.id !== requested?.id && account.enabled),
  ].slice(0, 60);
  let transientError: VideoApiError | null = null;
  for (const account of candidates) {
    if (signal.aborted) throw signal.reason;
    const login = await browser.checkLogin(account);
    if (login.status !== "logged-in") continue;
    const client = browser.client(account);
    try {
      const status = await client.poll(taskId, { signal });
      return { account, client, status };
    } catch (error) {
      if (error instanceof VideoApiError && error.kind === "not_found") continue;
      if (error instanceof VideoApiError && ["unavailable", "timeout", "network"].includes(error.kind)) {
        transientError = error;
        continue;
      }
      if (error instanceof VideoApiError && error.kind === "authentication") continue;
      throw error;
    }
  }
  if (transientError) throw transientError;
  throw new VideoApiError("not_found", "已检查可用 Vidu 账号，但都未找到该任务", 404);
}

export type ViduSubmissionCheckResult = {
  storyboard: ReturnType<StoryboardRepository["get"]>;
  phase: VideoTaskStatus["phase"];
  providerStatus: string;
  progress: number | null;
  resultUrl: string | null;
};

export async function checkViduSubmissionNow(options: {
  storyboards: StoryboardRepository;
  accounts: ViduAccountRepository;
  browser: ViduBrowserAccess;
  storyboardId: number;
}): Promise<ViduSubmissionCheckResult> {
  let storyboard = options.storyboards.get(options.storyboardId);
  const taskId = storyboard.videoTaskId;
  if (!taskId) throw new Error("该分镜还没有可检查的 Vidu 网站任务");
  if (storyboard.videoProvider !== "vidu-browser") throw new Error("该分镜不是 Vidu 浏览器任务");
  const leaseOwner = `manual:${process.pid}:${randomUUID()}`;
  const claimed = options.storyboards.claimViduRecoveryLease(
    storyboard.id,
    taskId,
    leaseOwner,
    Date.now(),
    21 * 60_000,
    true,
    0,
    undefined,
    "manual",
  );
  if (!claimed) throw new Error("该 Vidu 任务正在检查或恢复中，请稍后再试");
  try {
    const located = await locateViduRecoveryAccount(
      options.accounts,
      options.browser,
      taskId,
      storyboard.videoAccountId ?? undefined,
      new AbortController().signal,
    );
    storyboard = options.storyboards.saveVideoProviderTask(
      storyboard.id,
      taskId,
      "vidu-browser",
      located.account.id,
    );
    const status = located.status;
    const message = status.phase === "failed"
      ? status.error || `Vidu 任务失败: ${status.providerStatus}`
      : status.phase === "succeeded" && !status.resultUrl
        ? "Vidu 已生成完成，正在等待下载地址"
        : status.phase === "succeeded"
          ? "Vidu 已生成完成，后台任务正在下载"
          : `Vidu 任务状态: ${status.providerStatus}`;
    const recoveryState: VideoRecoveryState = status.phase === "failed"
      ? "failed"
      : status.phase === "succeeded" && !status.resultUrl
        ? "waiting_url"
        : "processing";
    storyboard = options.storyboards.setVideoRecoveryState(storyboard.id, recoveryState, message, "manual");
    options.storyboards.appendEvent(storyboard.id, {
      eventType: "manual_check_result",
      message,
      detail: {
        phase: status.phase,
        providerStatus: status.providerStatus,
        progress: status.progress,
        resultUrl: status.resultUrl,
        accountId: located.account.id,
      },
      taskId,
    });
    return {
      storyboard,
      phase: status.phase,
      providerStatus: status.providerStatus,
      progress: status.progress,
      resultUrl: status.resultUrl,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    storyboard = options.storyboards.setVideoRecoveryState(
      storyboard.id,
      recoveryStateForError(error, storyboard.videoRecoveryState),
      message,
      "manual",
    );
    options.storyboards.appendEvent(storyboard.id, {
      eventType: "manual_check_failed",
      message,
      detail: null,
      taskId,
    });
    throw error;
  } finally {
    options.storyboards.releaseViduRecoveryLease(storyboard.id, taskId, leaseOwner);
  }
}

export function createVideoGenerationHandler(options: {
  settings: Pick<SettingsStorage, "get" | "set">;
  storyboards: StoryboardRepository;
  projects: ProjectRepository;
  characterProfiles?: CharacterProfileRepository;
  projectsRoot: string;
  viduAccounts?: ViduAccountRepository;
  viduBrowser?: ViduBrowserAccess;
  clientFactory?: VideoClientFactory;
  keyPool?: ApiKeyPool;
}): JobHandler<VideoGenerationInput, VideoGenerationOutput> {
  const clientFactory = options.clientFactory ?? ((clientOptions) => new AsyncVideoTaskClient(clientOptions));
  const keyPool = options.keyPool ?? new ApiKeyPool();
  options.viduAccounts?.reactivateRecoverableAccounts();
  const viduAccountCoordinator = options.viduAccounts && options.viduBrowser
    ? new ViduAccountChannelPool(options.viduAccounts, options.viduBrowser)
    : null;

  return async (rawInput: VideoGenerationInput, context: JobExecutionContext) => {
    const input = videoGenerationInput.parse(rawInput);
    let storyboard = options.storyboards.get(input.storyboardId);
    const project = options.projects.get(storyboard.projectId);
    const projectDirectory = project.folderPath.trim() || join(options.projectsRoot, `project-${project.id}`);
    const prompt = input.prompt?.trim() || storyboard.prompt.trim();
    if (!prompt) throw new Error("分镜没有可用于生成视频的画面提示词");

    if (storyboard.videoSubmissionState === "uncertain") {
      throw new Error("该分镜的 Vidu 提交结果不确定，请先在视频页面绑定网站 task ID 或确认清除，程序不会自动重复提交");
    }
    if (storyboard.videoSubmissionState === "submitting" && !storyboard.videoTaskId) {
      options.storyboards.markVideoSubmissionUncertain(storyboard.id, storyboard.videoProvider, storyboard.videoAccountId);
      throw new Error("程序上次在 Vidu 提交阶段中断，结果已标记为待确认，避免重复扣费");
    }

    const selectedProvider = input.provider ?? providerSetting(options.settings.get("video_provider"));
    const provider: VideoProvider = storyboard.videoTaskId ? storyboard.videoProvider : selectedProvider;
    let account: ViduAccount | null = null;
    let providerTaskId = storyboard.videoTaskId;
    let videoPath: string | null = null;
    const requestTimeoutMs = optionalInteger(options.settings, "video_request_timeout_ms", 30_000, 1_000, 10 * 60_000);
    const pollIntervalMs = optionalInteger(
      options.settings,
      provider === "vidu-browser" ? "vidu_poll_interval_ms" : "video_poll_interval_ms",
      provider === "vidu-browser" ? 5_000 : 2_000,
      250,
      60_000,
    );
    const overallTimeoutMs = optionalInteger(options.settings, "video_timeout_ms", 30 * 60_000, 1_000, 24 * 60 * 60_000);
    const downloadTimeoutMs = optionalInteger(options.settings, "video_download_timeout_ms", 5 * 60_000, 1_000, 24 * 60 * 60_000);
    const maxDownloadMb = optionalInteger(options.settings, "video_max_download_mb", 2_048, 1, 16_384);

    const finish = async (
      client: GenerationClient,
      model: string,
      currentProvider: VideoProvider,
      currentAccount: ViduAccount | null,
    ): Promise<VideoGenerationOutput> => {
      const accountId = currentAccount?.id ?? null;
      const updateRecovery = (state: VideoRecoveryState, message: string): void => {
        if (storyboard.videoRecoveryState === state && storyboard.videoRecoveryMessage === message) return;
        storyboard = options.storyboards.setVideoRecoveryState(storyboard.id, state, message);
      };
      const completed: CompletedVideoTask = await client.waitForResult(providerTaskId!, {
        signal: context.signal,
        timeoutMs: overallTimeoutMs,
        pollIntervalMs,
        onProgress: (status) => {
          updateRecovery(
            status.phase === "succeeded" && !status.resultUrl ? "waiting_url" : "processing",
            status.phase === "succeeded" && !status.resultUrl
              ? "Vidu 已生成完成，正在等待下载地址"
              : `Vidu 任务状态: ${status.providerStatus}`,
          );
          emitPollProgress(context, status);
        },
      });
      context.updateProgress(82, "正在下载生成的视频");
      const viduDirectory = currentProvider === "vidu-browser" && currentAccount
        ? join(projectDirectory, "videos", `browser_${currentAccount.sortOrder + 1}`)
        : join(projectDirectory, "videos");
      const viduFileName = currentProvider === "vidu-browser" ? `${storyboard.index + 1}.mp4` : undefined;
      const downloaded = await client.downloadResult(completed.resultUrl, {
        outputDirectory: viduDirectory,
        stem: currentProvider === "vidu-browser" ? String(storyboard.index + 1) : `storyboard-${storyboard.index + 1}`,
        fileName: viduFileName,
        signal: context.signal,
        timeoutMs: downloadTimeoutMs,
        maxBytes: maxDownloadMb * 1024 * 1024,
      });
      videoPath = downloaded.path;
      if (context.signal.aborted) throw context.signal.reason;
      const output: VideoGenerationOutput = {
        storyboardId: storyboard.id,
        provider: currentProvider,
        accountId,
        providerTaskId: providerTaskId!,
        videoPath,
        model,
        bytes: downloaded.bytes,
      };
      context.updateProgress(96, "视频已下载，正在写入分镜", {
        storyboardId: storyboard.id,
        provider: currentProvider,
        accountId,
        providerTaskId,
        videoPath,
        bytes: downloaded.bytes,
      });
      context.complete(output, () => options.storyboards.attachGeneratedVideo(storyboard.id, videoPath!));
      return output;
    };

    try {
      if (provider === "vidu-browser") {
        if (!options.viduAccounts || !options.viduBrowser) throw new Error("当前运行环境未启用 Vidu 浏览器服务");
        const configuredUseCredits = input.useCredits ?? booleanSetting(options.settings.get("vidu_use_credits"), false);
        const dispatchMode = viduAccountDispatchMode(options.settings.get("vidu_account_dispatch_mode"));
        const requestedAccountId = providerTaskId
          ? storyboard.videoAccountId ?? undefined
          : (input.accountId ?? options.settings.get("vidu_default_account_id")?.trim()) || undefined;
        const model = viduModelForStoryboard(
          storyboard.index,
          input,
          modelSetting(options.settings.get("vidu_model")),
        );
        const requestedUseCredits = model === "Q3" || configuredUseCredits;
        let preparedPrompt = prompt;
        let preparedSubjects = storyboard.subjects;
        const nextSubjectAppearances: Record<string, number> = {};
        if (!providerTaskId) {
          const boundPrompt = bindViduSubjects(prompt, storyboard.subjects);
          const profiles = options.characterProfiles?.list(project.id) ?? [];
          const standardName = new Map<string, string>();
          profiles.forEach((profile) => {
            [profile.name, ...profile.aliases].forEach((name) => {
              const key = name.trim().toLocaleLowerCase();
              if (key && !standardName.has(key)) standardName.set(key, profile.name);
            });
          });
          preparedPrompt = boundPrompt.replace(/@([\w\u4e00-\u9fff]+)/gu, (_match, name: string) =>
            `@${standardName.get(name.toLocaleLowerCase()) ?? name}`,
          );
          preparedSubjects = Array.from(new Set(storyboard.subjects.map((name) =>
            standardName.get(name.trim().toLocaleLowerCase()) ?? name.trim(),
          ).filter(Boolean)));
          for (const future of options.storyboards.list(project.id)) {
            if (future.index <= storyboard.index) continue;
            const futurePrompt = bindViduSubjects(future.prompt, future.subjects);
            const futureNames = extractViduRoleNames(futurePrompt).map((name) =>
              standardName.get(name.trim().toLocaleLowerCase()) ?? name.trim(),
            );
            for (const name of futureNames) {
              if (name && nextSubjectAppearances[name] === undefined) nextSubjectAppearances[name] = future.index + 1;
            }
          }
          const assetNames = extractViduRoleNames(preparedPrompt);
          context.updateProgress(3, "正在检查项目角色、场景和特殊空间资产", { assetNames });
          await preflightCharacterAssets(projectDirectory, assetNames);
        }
        if (providerTaskId) {
          const located = await locateViduRecoveryAccount(
            options.viduAccounts,
            options.viduBrowser,
            providerTaskId,
            requestedAccountId,
            context.signal,
          );
          account = located.account;
          const client = located.client;
          storyboard = options.storyboards.saveVideoProviderTask(storyboard.id, providerTaskId, provider, account.id);
          context.updateProgress(12, "继续等待已有 Vidu 任务", { providerTaskId, accountId: account.id });
          return await finish(client, model, provider, account);
        }

        const attemptedIds = new Set<string>();
        for (;;) {
          const accountLease = await viduAccountCoordinator!.acquire({
            requestedId: requestedAccountId,
            allowFallback: !input.accountId,
            useCredits: requestedUseCredits,
            dispatchMode,
            excludedIds: attemptedIds,
            signal: context.signal,
          });
          account = accountLease.account;
          try {
            const client = options.viduBrowser.client(account);
            const effectiveUseCredits = account.accountType === "points" || requestedUseCredits;
            context.updateProgress(4, "正在准备 Vidu 主体素材", { accountId: account.id, model });
            options.storyboards.beginVideoSubmission(storyboard.id, provider, account.id);
            try {
              const submitted = await client.submit({
                projectId: project.id,
                prompt: preparedPrompt,
                subjects: preparedSubjects,
                durationSeconds: input.durationSeconds ?? storyboard.duration,
                model,
                useCredits: effectiveUseCredits,
                aspectRatio: input.aspectRatio || options.settings.get("video_aspect_ratio")?.trim() || "16:9",
                projectDirectory,
                storyboardIndex: storyboard.index + 1,
                nextSubjectAppearances,
              }, {
                signal: context.signal,
                onThrottled: ({ reason, inProgress, retryInMs }) => {
                  const retrySeconds = Math.round(retryInMs / 1_000);
                  const message = reason === "in_progress"
                    ? `Vidu 当前有 ${inProgress ?? 100} 个在途任务，${retrySeconds} 秒后自动探测恢复`
                    : `Vidu 暂时限流，${retrySeconds} 秒后自动探测恢复`;
                  context.updateProgress(4, message, { accountId: account?.id ?? null, reason, inProgress, retryInMs });
                  context.emit("warning", message, { accountId: account?.id ?? null, reason, inProgress, retryInMs });
                },
                onThrottleRecovered: ({ inProgress }) => {
                  context.updateProgress(4, "Vidu 队列已恢复，继续提交视频任务", { accountId: account?.id ?? null, inProgress });
                  context.emit("info", "Vidu 队列已恢复，继续提交视频任务", { accountId: account?.id ?? null, inProgress });
                },
                onSubjectPreparation: ({ phase, current, total, name }) => {
                  const event = phase === "start" ? "PREP_START" : phase === "end" ? "PREP_END" : "PREP";
                  const progress = phase === "end"
                    ? 10
                    : Math.min(9, 4 + Math.round((current / Math.max(total, 1)) * 5));
                  context.updateProgress(
                    progress,
                    phase === "end" ? "Vidu 角色注册完成" : `Vidu 角色注册中：${name}`,
                    {
                      kind: "subject-prep",
                      event,
                      phase,
                      current,
                      total,
                      name,
                      storyboardId: storyboard.id,
                      accountId: account?.id ?? null,
                    },
                  );
                },
              });
              providerTaskId = submitted.taskId;
              storyboard = options.storyboards.saveVideoProviderTask(storyboard.id, providerTaskId, provider, account.id);
              options.viduAccounts.recordUsage(account.id, effectiveUseCredits);
              context.updateProgress(12, "Vidu 任务已提交", { providerTaskId, accountId: account.id });
              return await finish(client, model, provider, account);
            } catch (error) {
              const creditsRejected = isViduCreditsError(error);
              const planRejected = isViduPlanLimitError(error);
              const authenticationRejected = isConfirmedViduAuthenticationError(error);
              const subjectRejected = error instanceof VideoApiError && error.kind === "subject_limit";
              const accountRejected = !providerTaskId
                && (creditsRejected || planRejected || authenticationRejected || subjectRejected);
              if (!accountRejected) throw error;
              attemptedIds.add(account.id);
              options.storyboards.clearVideoProviderTask(storyboard.id);
              if (authenticationRejected) {
                options.viduAccounts.markLoginExpired(account.id, error.message);
              } else if (subjectRejected) {
                viduAccountCoordinator!.deferSubjectLimited(account.id, error.message);
              } else if (creditsRejected) {
                viduAccountCoordinator!.deferCreditsRejected(
                  account.id,
                  error instanceof Error ? error.message : String(error),
                );
              }
              accountLease.reject();
              if (input.accountId) throw error;
              context.emit("warning", subjectRejected
                ? `账号“${account.name}”主体库暂时受限，账号积分不受影响，正在切换下一个账号`
                : `账号“${account.name}”不可用，正在自动切换下一个账号`, {
                accountId: account.id,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          } finally {
            accountLease.release();
          }
        }
      }

      const baseUrl = required(options.settings, "video_api_base_url", "视频 API 地址");
      const model = required(options.settings, "video_model", "视频模型");
      const concurrencyPerKey = optionalInteger(options.settings, "video_concurrency_per_key", 2, 1, 32);
      const pollMethod = options.settings.get("video_poll_method")?.trim().toUpperCase() === "POST" ? "POST" : "GET";
      const keys = parseApiKeys(options.settings.get("video_api_key"), options.settings.get("video_api_keys"));
      return await keyPool.run({
        keys,
        concurrencyPerKey,
        signal: context.signal,
        canRetry: canTryAnotherVideoKey,
        onRetry: (error, attempt) => context.emit(
          "warning",
          "当前视频 API Key 请求失败，正在切换下一个 Key",
          retryDetail(error, attempt),
        ),
        operation: async (apiKey) => {
          const client = clientFactory({
            baseUrl,
            apiKey,
            apiKeyHeader: options.settings.get("video_api_key_header")?.trim() || undefined,
            submitPath: options.settings.get("video_submit_path")?.trim() || undefined,
            statusPath: options.settings.get("video_status_path")?.trim() || undefined,
            pollMethod,
            requestTimeoutMs,
            pollIntervalMs,
            overallTimeoutMs,
            sendAuthToResult: booleanSetting(options.settings.get("video_result_send_auth")),
          });
          if (providerTaskId) {
            context.updateProgress(12, "继续等待已有视频任务", { providerTaskId });
          } else {
            context.updateProgress(6, "正在提交视频生成任务", { model });
            options.storyboards.beginVideoSubmission(storyboard.id, provider, null);
            const submitted = await client.submit({
              model,
              prompt,
              durationSeconds: input.durationSeconds ?? storyboard.duration,
              aspectRatio: input.aspectRatio,
              imageUrl: input.imageUrl,
              parameters: input.parameters,
            }, { signal: context.signal });
            providerTaskId = submitted.taskId;
            storyboard = options.storyboards.saveVideoProviderTask(storyboard.id, providerTaskId, provider, null);
            context.updateProgress(12, "视频任务已提交", { providerTaskId });
          }
          return finish(client, model, provider, null);
        },
      });
    } catch (error) {
      if (videoPath) await rm(videoPath, { force: true }).catch(() => undefined);
      const terminalViduFailure = providerTaskId
        && provider === "vidu-browser"
        && error instanceof VideoApiError
        && error.kind === "provider_failed"
        && !context.signal.aborted;
      if (terminalViduFailure) {
        storyboard = options.storyboards.clearFailedVideoProviderTask(
          storyboard.id,
          error instanceof Error ? error.message : String(error),
        );
      } else if (providerTaskId && provider === "vidu-browser" && !context.signal.aborted) {
        const current = options.storyboards.get(storyboard.id);
        const state = recoveryStateForError(error, current.videoRecoveryState);
        storyboard = options.storyboards.setVideoRecoveryState(
          storyboard.id,
          state,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (provider === "vidu-browser" && error instanceof VideoApiError && error.kind === "invalid_response" && !providerTaskId) {
        options.storyboards.markVideoSubmissionUncertain(storyboard.id, provider, account?.id ?? storyboard.videoAccountId);
      } else if (terminalViduFailure) {
        // The provider confirmed a terminal failure, so there is no task left to recover.
      } else if (providerTaskId && provider === "vidu-browser") {
        options.storyboards.saveVideoProviderTask(storyboard.id, providerTaskId, provider, account?.id ?? storyboard.videoAccountId);
      } else if (context.signal.aborted && !isExplicitCancellation(context.signal) && providerTaskId) {
        options.storyboards.saveVideoProviderTask(storyboard.id, providerTaskId, provider, account?.id ?? storyboard.videoAccountId);
      } else {
        options.storyboards.clearVideoProviderTask(storyboard.id);
      }
      if (error instanceof VideoApiError) {
        context.emit("error", provider === "vidu-browser" ? "Vidu 视频任务失败" : "视频模型任务失败", {
          kind: error.kind,
          status: error.status ?? null,
          requestId: error.requestId ?? null,
          providerTaskId,
          accountId: account?.id ?? null,
        });
      }
      throw error;
    }
  };
}

export function registerVideoWorkflowHandler(
  queue: PersistentJobQueue,
  options: Parameters<typeof createVideoGenerationHandler>[0],
): void {
  const defaultAccountId = options.settings.get("vidu_default_account_id")?.trim();
  if (
    defaultAccountId
    && options.viduAccounts
    && !options.viduAccounts.list().some((account) => account.id === defaultAccountId)
  ) {
    options.settings.set("vidu_default_account_id", "");
  }
  queue.register("video.generate", createVideoGenerationHandler(options));
}
