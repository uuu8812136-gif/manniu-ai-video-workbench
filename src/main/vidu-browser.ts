import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { BrowserWindow, nativeImage, session, shell, type Session } from "electron";
import type {
  ViduAccount,
  ViduAccountStatus,
  ViduSubjectOperationResult,
} from "../shared/contracts";
import type { ViduMaterialCacheRepository } from "./repositories";
import {
  bindViduSubjects,
  buildViduCharacterPayload,
  extractViduRoleNames,
  extractViduSubmittedTaskId,
  extractViduTaskId,
  normalizeViduTask,
  viduTasks,
  type ViduGenerationClient,
  type ViduMaterial,
  type ViduSubmitOptions,
  type ViduSubmitRequest,
} from "./vidu-protocol";
import { AsyncVideoTaskClient, VideoApiError, type VideoTaskStatus } from "./video-client";
import { findCharacterAsset } from "./character-assets";
import { inspectViduJwt, redactViduJwt } from "./vidu-jwt";

type PageResponse = { status: number; body: string };
type JsonObject = Record<string, unknown>;
type MaterialStage = "upload" | "put" | "finish" | "pre-process" | "create" | "edit";

export type ViduSubjectClipboardComponent = {
  type: string;
  contentType: string;
  selectedRegion: JsonObject;
  contentUrl: string;
  sourceImageUrl: string;
};

export type ViduSubjectClipboardItem = {
  name: string;
  labels: unknown[];
  voice: JsonObject;
  modality: string;
  components: ViduSubjectClipboardComponent[];
};

export type ViduSubjectClipboard = {
  version: 1;
  copiedAt: string;
  sourceAccountName: string;
  subjects: ViduSubjectClipboardItem[];
};

class ViduMaterialOperationError extends Error {
  constructor(
    readonly stage: MaterialStage,
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = "ViduMaterialOperationError";
  }
}

export type ViduReplacementCandidate = {
  material: ViduMaterial;
  belongsToProject: boolean;
  nextAppearance: number | null;
};

const VIDU_PAGE = "https://www.vidu.cn/create/character2video";
const SERVICE = "https://service.vidu.cn";
const HISTORY = `${SERVICE}/vidu/v1/tasks/history/me`;
const CREDITS = `${SERVICE}/credit/v1/credits/me`;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const TERMINAL = new Set(["success", "failed", "error", "canceled", "cancelled", "deleted"]);
const DEFAULT_THROTTLE_PROBE_MS = 30_000;
const DEFAULT_SUBMIT_RETRY_MS = 2_000;
const LOGIN_STATUS_TTL_MS = 7_500;
const SUBMIT_MAX_ATTEMPTS = 3;
const SUBMIT_WATCHDOG_MS = 5 * 60_000;
const CREDIT_KEYS = ["credits_free", "credits_subscribed", "credits_purchased", "credits_permanent"] as const;
const AUDIT_RETRY_DELAYS_MS = [10_000, 20_000] as const;
const MATERIAL_RETRY_DELAY_MS = 3_000;
const MATERIAL_MAX_ATTEMPTS = 3;
const SUBJECT_ASSET_MAX_BYTES = 30 * 1024 * 1024;
const SUBJECT_IMPORT_CONCURRENCY = 3;
const SENSITIVE_CLIPBOARD_KEY = /(?:^|[_-])(?:jwt|cookies?|authorization|password|passwd|secret|tokens?|keys?)(?:$|[_-])/i;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizedClipboardJson(value: unknown, depth = 0): unknown {
  if (depth > 16 || value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => sanitizedClipboardJson(item, depth + 1));
  if (!isObject(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_CLIPBOARD_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2")))
      .map(([key, child]) => [key, sanitizedClipboardJson(child, depth + 1)]),
  );
}

function clipboardString(value: unknown, field: string, maxLength = 20_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`Vidu 主体剪贴板字段无效: ${field}`);
  }
  return value;
}

function clipboardUrl(value: unknown, field: string): string {
  if (value === "" || value === undefined || value === null) return "";
  const url = clipboardString(value, field, 20_000);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`Vidu 主体素材地址必须使用 HTTPS: ${field}`);
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost"
    || host === "0.0.0.0"
    || host === "::1"
    || /^127\./u.test(host)
    || /^10\./u.test(host)
    || /^192\.168\./u.test(host)
    || /^169\.254\./u.test(host)
    || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)
  ) throw new Error(`Vidu 主体素材地址不能指向本地网络: ${field}`);
  return parsed.toString();
}

export function parseViduSubjectClipboard(value: unknown): ViduSubjectClipboard {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.subjects)) {
    throw new Error("本地主体剪贴板格式无效或版本不兼容");
  }
  return {
    version: 1,
    copiedAt: clipboardString(value.copiedAt, "copiedAt", 100),
    sourceAccountName: clipboardString(value.sourceAccountName, "sourceAccountName", 160),
    subjects: value.subjects.map((subjectValue, subjectIndex) => {
      if (!isObject(subjectValue) || !Array.isArray(subjectValue.components)) {
        throw new Error(`Vidu 主体剪贴板第 ${subjectIndex + 1} 项格式无效`);
      }
      const sanitizedVoice = sanitizedClipboardJson(subjectValue.voice ?? {});
      const sanitizedLabels = sanitizedClipboardJson(subjectValue.labels ?? []);
      if (!isObject(sanitizedVoice) || !Array.isArray(sanitizedLabels)) {
        throw new Error(`Vidu 主体剪贴板第 ${subjectIndex + 1} 项元数据无效`);
      }
      const components = subjectValue.components.map((componentValue, componentIndex) => {
        if (!isObject(componentValue)) {
          throw new Error(`Vidu 主体剪贴板第 ${subjectIndex + 1} 项组件 ${componentIndex + 1} 无效`);
        }
        const selectedRegion = sanitizedClipboardJson(componentValue.selectedRegion ?? {});
        if (!isObject(selectedRegion)) throw new Error(`Vidu 主体剪贴板第 ${subjectIndex + 1} 项裁剪区域无效`);
        const component = {
          type: clipboardString(componentValue.type ?? "main", "component.type", 100),
          contentType: clipboardString(componentValue.contentType ?? "image", "component.contentType", 100),
          selectedRegion,
          contentUrl: clipboardUrl(componentValue.contentUrl, "component.contentUrl"),
          sourceImageUrl: clipboardUrl(componentValue.sourceImageUrl, "component.sourceImageUrl"),
        };
        if (!component.contentUrl && !component.sourceImageUrl) {
          throw new Error(`Vidu 主体剪贴板第 ${subjectIndex + 1} 项组件 ${componentIndex + 1} 没有素材地址`);
        }
        return component;
      });
      if (components.length === 0) throw new Error(`Vidu 主体剪贴板第 ${subjectIndex + 1} 项没有素材组件`);
      return {
        name: clipboardString(subjectValue.name, `subjects[${subjectIndex}].name`, 240),
        labels: sanitizedLabels,
        voice: sanitizedVoice,
        modality: clipboardString(subjectValue.modality ?? "image", `subjects[${subjectIndex}].modality`, 100),
        components,
      };
    }),
  };
}

function json(value: string): unknown {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function parsedJson(value: string): { ok: true; data: unknown } | { ok: false; data: null } {
  try {
    return { ok: true, data: JSON.parse(value) };
  } catch {
    return { ok: false, data: null };
  }
}

function nestedHasValue(value: unknown, keys: ReadonlySet<string>, containers: ReadonlySet<string>): boolean {
  if (!isObject(value)) return false;
  if (Object.entries(value).some(([key, child]) => keys.has(key) && child !== null && child !== undefined && child !== "")) return true;
  return Object.entries(value).some(([key, child]) => containers.has(key) && nestedHasValue(child, keys, containers));
}

function hasUserIdentity(value: unknown): boolean {
  return nestedHasValue(value, new Set(["id", "uid", "user_id", "sub"]), new Set(["data", "user", "account", "result"]));
}

function hasCreditFields(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (CREDIT_KEYS.some((key) => Object.hasOwn(value, key))) return true;
  return ["data", "credits", "result"].some((key) => hasCreditFields(value[key]));
}

function looksLikeHistory(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (["tasks", "items", "list", "pager", "next_page_token"].some((key) => Object.hasOwn(value, key))) return true;
  return looksLikeHistory(value.data) || looksLikeHistory(value.result);
}

function historyNextPageToken(value: unknown): string {
  if (!isObject(value)) return "";
  if (typeof value.next_page_token === "string") return value.next_page_token;
  if (isObject(value.pager) && typeof value.pager.next_page_token === "string") return value.pager.next_page_token;
  for (const key of ["data", "result", "payload"] as const) {
    const nested = historyNextPageToken(value[key]);
    if (nested) return nested;
  }
  return "";
}

function looksLikeHtmlChallenge(value: string): boolean {
  const lower = value.toLowerCase();
  return (lower.includes("<!doctype html") || lower.includes("<html"))
    && (lower.includes("<script") || lower.includes("window._"));
}

function creditNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim().replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractAvailableViduCredits(value: unknown): number | null {
  if (!isObject(value)) return null;
  const components = CREDIT_KEYS.map((key) => creditNumber(value[key])).filter((part): part is number => part !== null);
  if (components.length > 0) return components.reduce((total, part) => total + part, 0);
  for (const key of ["data", "credits", "result"] as const) {
    const nested = extractAvailableViduCredits(value[key]);
    if (nested !== null) return nested;
  }
  return null;
}

export async function fingerprintViduAsset(path: string): Promise<string> {
  return createHash("sha1").update(await readFile(path)).digest("hex");
}

export function chooseViduReplacementCandidate(
  candidates: readonly ViduReplacementCandidate[],
  neededNow: ReadonlySet<string>,
): ViduMaterial | null {
  const available = candidates.filter(({ material }) => !neededNow.has(material.name));
  const oldProjectMaterial = available.find(({ belongsToProject }) => !belongsToProject);
  if (oldProjectMaterial) return oldProjectMaterial.material;
  return [...available]
    .sort((left, right) => {
      const leftIndex = left.nextAppearance ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = right.nextAppearance ?? Number.MAX_SAFE_INTEGER;
      return rightIndex - leftIndex;
    })[0]?.material ?? null;
}

export function viduMaterialRetryDelay(
  stage: MaterialStage,
  status: number,
  body: string,
  attempt: number,
): number | null {
  if (stage === "pre-process" && status === 400 && /AuditSubmitIllegal/i.test(body)) {
    return AUDIT_RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), AUDIT_RETRY_DELAYS_MS.length - 1)];
  }
  if (stage === "upload" || stage === "put" || stage === "finish") return MATERIAL_RETRY_DELAY_MS;
  if ([408, 409, 425, 429].includes(status) || status >= 500 || status === 0) return MATERIAL_RETRY_DELAY_MS;
  return null;
}

export function viduSubjectPreparationGapMs(completed: number, total: number): number {
  if (completed >= total) return 0;
  return completed > 0 && completed % 3 === 0 ? 10_000 : 3_000;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const cancel = (): void => { clearTimeout(timer); cleanup(); reject(signal?.reason); };
    const cleanup = (): void => signal?.removeEventListener("abort", cancel);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function contentType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function providerMessage(body: string, fallback: string): string {
  const value = json(body);
  if (isObject(value)) {
    for (const key of ["message", "reason", "error", "err_msg"]) {
      const result = value[key];
      if (typeof result === "string" && result.trim()) return result.trim();
    }
  }
  return fallback;
}

export function isViduQuotaFailure(body: string): boolean {
  return /CreditNotEnough|CreditsNotEnough|CreditNotAvailable|CreditsNotAvailable|NotEnoughCredits?|InsufficientCredits?|InsufficientBalance|BalanceInsufficient|CreditBalanceInsufficient|QuotaExceeded|QuotaExhausted|credits?\s*insufficient|quota|额度|积分不足/i.test(body);
}

export function isViduPlanLimitFailure(body: string): boolean {
  return /NonPeakTaskSubmitLimitExceeded|SubPlanNotSupportedForTask/i.test(body);
}

export function isViduSubjectLimitFailure(body: string): boolean {
  return /ACCOUNT_SUBJECT_LIMITED|ElementOperateLimitExceeded|MonthLimit|FreeMonth|Subject(?:Library|Material)?.*Limit(?:ed|Exceeded)|主体(?:库|素材)?.*(?:操作频率|创建频率|上限|限频|超限|限制)|主体库操作频率超限/i.test(body);
}

function subjectLimitError(body: string, status: number): VideoApiError {
  return new VideoApiError("subject_limit", providerMessage(body, "Vidu 主体库操作频率超限"), status);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new VideoApiError("cancelled", "Vidu 任务提交已取消");
}

const accountSubmissionQueues = new Map<string, Promise<void>>();

async function exclusiveViduAccountOperation<T>(
  accountKey: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  throwIfCancelled(signal);
  const previous = accountSubmissionQueues.get(accountKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  accountSubmissionQueues.set(accountKey, current);
  await previous;
  try {
    throwIfCancelled(signal);
    return await operation();
  } finally {
    release();
    if (accountSubmissionQueues.get(accountKey) === current) accountSubmissionQueues.delete(accountKey);
  }
}

async function waitForThrottle(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, signal);
  } catch (error) {
    if (signal?.aborted) throw new VideoApiError("cancelled", "Vidu 任务提交已取消", undefined, undefined, undefined, { cause: error });
    throw error;
  }
}

function sessionFetch(current: Session): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => current.fetch(input instanceof URL ? input.toString() : input, init)) as typeof fetch;
}

export class ViduBrowserClient implements ViduGenerationClient {
  private browserWindow: BrowserWindow | null = null;
  private loadPromise: Promise<void> | null = null;
  private disposed = false;
  private readonly preparedAssets = new Map<string, string>();

  constructor(readonly account: ViduAccount, private readonly materialCache?: ViduMaterialCacheRepository) {
    if (!/^[0-9a-f-]{36}$/i.test(account.sessionKey)) throw new Error("Vidu 账号会话标识无效");
  }

  private get browserSession(): Session {
    return session.fromPartition(`persist:vidu-${this.account.sessionKey.toLowerCase()}`);
  }

  private async ensureWindow(show: boolean): Promise<BrowserWindow> {
    if (this.disposed) throw new Error("Vidu 浏览器服务已关闭");
    if (!this.browserWindow || this.browserWindow.isDestroyed()) {
      const window = new BrowserWindow({
        width: 1280,
        height: 900,
        minWidth: 960,
        minHeight: 680,
        show: false,
        title: `AI工具 - ${this.account.name}`,
        backgroundColor: "#0b1016",
        webPreferences: {
          partition: `persist:vidu-${this.account.sessionKey.toLowerCase()}`,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      this.browserWindow = window;
      window.on("closed", () => {
        if (this.browserWindow === window) this.browserWindow = null;
        this.loadPromise = null;
      });
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (!url.startsWith("https://")) return { action: "deny" };
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 760,
            height: 820,
            show: window.isVisible(),
            parent: window,
            modal: false,
            webPreferences: {
              partition: `persist:vidu-${this.account.sessionKey.toLowerCase()}`,
              contextIsolation: true,
              sandbox: true,
              nodeIntegration: false,
            },
          },
        };
      });
      window.webContents.on("will-navigate", (event, url) => {
        if (!/^https:\/\/([a-z0-9-]+\.)*vidu\.cn\//i.test(url) && !/^https:\/\/([a-z0-9-]+\.)*vidu\.com\//i.test(url)) {
          event.preventDefault();
          void shell.openExternal(url);
        }
      });
      this.loadPromise = window.loadURL(VIDU_PAGE).then(
        () => undefined,
        (error: unknown) => {
          if (this.browserWindow === window) {
            this.browserWindow = null;
            this.loadPromise = null;
          }
          if (!window.isDestroyed()) window.destroy();
          throw error;
        },
      );
    }
    await this.loadPromise;
    if (show) {
      this.browserWindow.show();
      this.browserWindow.focus();
    }
    return this.browserWindow;
  }

  async openLogin(): Promise<void> {
    await this.ensureWindow(true);
  }

  async loginWithJwt(jwt: string, ssuid?: string): Promise<ViduAccountStatus> {
    inspectViduJwt(jwt);
    await this.clearSession();
    const currentSession = this.browserSession;
    const expirationDate = Math.floor(Date.now() / 1_000) + 30 * 24 * 60 * 60;
    try {
      await currentSession.cookies.set({
        url: `${SERVICE}/`,
        domain: "service.vidu.cn",
        path: "/",
        name: "JWT",
        value: jwt,
        secure: true,
        httpOnly: true,
        sameSite: "no_restriction",
        expirationDate,
      });
      if (ssuid?.trim()) {
        await currentSession.cookies.set({
          url: `${SERVICE}/`,
          domain: "service.vidu.cn",
          path: "/",
          name: "SSUID",
          value: ssuid.trim(),
          secure: true,
          httpOnly: true,
          sameSite: "no_restriction",
          expirationDate,
        });
      }
      await currentSession.cookies.flushStore();
      const window = await this.ensureWindow(false);
      await window.webContents.executeJavaScript(
        `localStorage.setItem("token", ${JSON.stringify(jwt)}); localStorage.setItem("VIDU_STORE", ${JSON.stringify(JSON.stringify({ state: { modelVersion: "3.0" }, version: 0 }))});`,
        true,
      );
      const checks = [
        ["user", `${SERVICE}/iam/v1/users/me`, hasUserIdentity],
        ["credits", CREDITS, hasCreditFields],
        ["history", `${HISTORY}?pager.pagesz=1&types=character2video`, looksLikeHistory],
      ] as const;
      const failures: string[] = [];
      let verified = false;
      for (const [label, url, validate] of checks) {
        const response = await this.pageRequest(url, { method: "GET" });
        const parsed = parsedJson(response.body);
        if (response.status === 200 && parsed.ok && validate(parsed.data)) {
          verified = true;
          break;
        }
        failures.push(response.status === 200 && looksLikeHtmlChallenge(response.body)
          ? `${label}:html_challenge`
          : `${label}:HTTP ${response.status}${parsed.ok ? ":unexpected_json" : ":non_json"}`);
      }
      if (!verified) throw new Error(`Vidu JWT verification failed (${failures.join(", ")})`);
      return { accountId: this.account.id, status: "logged-in", httpStatus: 200, message: "Vidu JWT 登录成功" };
    } catch (error) {
      await this.clearSession().catch(() => undefined);
      const message = redactViduJwt(error instanceof Error ? error.message : String(error));
      throw new Error(message || "Vidu JWT 登录验证失败");
    }
  }

  async status(): Promise<ViduAccountStatus> {
    try {
      const response = await this.sessionRequest(`${HISTORY}?pager.pagesz=1&types=character2video`, { method: "GET" });
      const parsed = parsedJson(response.body);
      if (response.status === 200 && parsed.ok && looksLikeHistory(parsed.data)) {
        const creditsResponse = await this.sessionRequest(CREDITS, { method: "GET" });
        const credits = creditsResponse.status === 200
          ? extractAvailableViduCredits(json(creditsResponse.body))
          : null;
        return {
          accountId: this.account.id,
          status: "logged-in",
          httpStatus: 200,
          message: "Vidu 账号已登录",
          availableCredits: credits,
        };
      }
      if (response.status === 401 || response.status === 403) {
        return { accountId: this.account.id, status: "logged-out", httpStatus: response.status, message: "请在 Vidu 窗口中登录账号" };
      }
      const detail = response.status === 200 && looksLikeHtmlChallenge(response.body) ? "HTML challenge" : `HTTP ${response.status}`;
      return { accountId: this.account.id, status: "unknown", httpStatus: response.status, message: `Vidu 登录状态不可确认: ${detail}` };
    } catch (error) {
      return { accountId: this.account.id, status: "unknown", httpStatus: null, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async clearSession(): Promise<void> {
    if (this.browserWindow && !this.browserWindow.isDestroyed()) this.browserWindow.destroy();
    this.browserWindow = null;
    this.loadPromise = null;
    this.preparedAssets.clear();
    await this.browserSession.clearStorageData();
    await this.browserSession.clearCache();
  }

  dispose(): void {
    this.disposed = true;
    if (this.browserWindow && !this.browserWindow.isDestroyed()) this.browserWindow.destroy();
    this.browserWindow = null;
    this.loadPromise = null;
  }

  private async sessionRequest(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<PageResponse> {
    const controller = new AbortController();
    const cancel = (): void => controller.abort(signal?.reason ?? new Error("Vidu request cancelled"));
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Vidu request timed out")), timeoutMs);
    try {
      const response = await this.browserSession.fetch(url, {
        method: init.method ?? "GET",
        headers: {
          Accept: "application/json, text/plain, */*",
          Origin: "https://www.vidu.cn",
          Referer: "https://www.vidu.cn/",
          "x-platform": "web",
          ...init.headers,
        },
        body: init.body,
        credentials: "include",
        redirect: "follow",
        signal: controller.signal,
      });
      return { status: response.status, body: (await response.text()).slice(0, 2_000_000) };
    } catch (error) {
      if (signal?.aborted) throw new VideoApiError("cancelled", "Vidu request was cancelled", undefined, undefined, undefined, { cause: error });
      return { status: 0, body: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  private async pageRequest(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<PageResponse> {
    const window = await this.ensureWindow(false);
    const request = JSON.stringify({
      method: init.method ?? "GET",
      headers: { Accept: "application/json", ...init.headers },
      body: init.body,
      credentials: "include",
    });
    const script = `(() => {
      const timeout = new Promise((resolve) => setTimeout(() => resolve({ status: 0, body: "timeout" }), 30000));
      const request = fetch(${JSON.stringify(url)}, ${request})
        .then(async (response) => ({ status: response.status, body: (await response.text()).slice(0, 2000000) }))
        .catch((error) => ({ status: 0, body: String(error && error.message ? error.message : error) }));
      return Promise.race([request, timeout]);
    })()`;
    return window.webContents.executeJavaScript(script, true) as Promise<PageResponse>;
  }

  private async jsonRequest(
    url: string,
    method: "POST" | "PUT",
    body: unknown,
  ): Promise<{ response: PageResponse; data: unknown }> {
    const response = await this.pageRequest(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { response, data: json(response.body) };
  }

  private async history(limit = 5): Promise<unknown> {
    const response = await this.pageRequest(`${HISTORY}?pager.pagesz=${limit}&types=character2video`, { method: "GET" });
    if (response.status === 401 || response.status === 403) throw new VideoApiError("authentication", "Vidu 登录已失效", response.status);
    if (response.status !== 200) throw new VideoApiError("http", `读取 Vidu 任务历史失败: HTTP ${response.status}`, response.status);
    return json(response.body);
  }

  private async findTaskInSessionHistory(taskId: string, signal?: AbortSignal): Promise<JsonObject | null> {
    let token = "";
    for (let page = 0; page < 8; page += 1) {
      const suffix = token ? `&pager.page_token=${encodeURIComponent(token)}` : "";
      const response = await this.sessionRequest(`${HISTORY}?pager.pagesz=100&types=character2video${suffix}`, { method: "GET" }, signal);
      if (response.status === 401 || response.status === 403) {
        throw new VideoApiError("authentication", "Vidu 登录已失效", response.status);
      }
      if (response.status === 0 || response.status === 429 || response.status >= 500) {
        throw new VideoApiError("unavailable", `Vidu history is temporarily unavailable: HTTP ${response.status}`, response.status);
      }
      if (response.status !== 200) return null;
      const payload = json(response.body);
      const task = viduTasks(payload).find((item) => extractViduTaskId(item) === taskId);
      if (task) return task;
      token = historyNextPageToken(payload);
      if (!token) break;
    }
    return null;
  }

  private async preflightCredits(request: ViduSubmitRequest): Promise<void> {
    if (!request.useCredits) return;
    const response = await this.pageRequest(CREDITS, { method: "GET" });
    if (response.status === 401) {
      throw new VideoApiError("authentication", "Vidu 登录已失效", response.status);
    }
    if (response.status !== 200) return;
    const available = extractAvailableViduCredits(json(response.body));
    if (available === null) return;
    const required = Math.max(1, Math.round(request.durationSeconds));
    if (available < required) {
      throw new VideoApiError("rate_limit", `Vidu 积分不足: 可用 ${available}，本次至少需要 ${required}`, response.status);
    }
  }

  private async countInProgress(): Promise<number> {
    let token = "";
    let count = 0;
    for (let page = 0; page < 3; page += 1) {
      const suffix = token ? `&pager.page_token=${encodeURIComponent(token)}` : "";
      const response = await this.pageRequest(`${HISTORY}?pager.pagesz=100&types=character2video${suffix}`, { method: "GET" });
      if (response.status === 401 || response.status === 403) throw new VideoApiError("authentication", "Vidu 登录已失效", response.status);
      if (response.status === 0 || response.status === 429 || response.status >= 500) {
        throw new VideoApiError("unavailable", `Vidu 在途任务查询暂不可用: HTTP ${response.status}`, response.status);
      }
      if (response.status !== 200) {
        throw new VideoApiError("http", `Vidu 在途任务查询失败: HTTP ${response.status}`, response.status);
      }
      const payload = json(response.body);
      const tasks = viduTasks(payload);
      count += tasks.filter((task) => !TERMINAL.has(String(task.state ?? task.status ?? "").toLowerCase())).length;
      token = historyNextPageToken(payload);
      if (!token) break;
    }
    return count;
  }

  private async listPersonalSubjectElements(): Promise<JsonObject[]> {
    const output: JsonObject[] = [];
    let token = "";
    const seenTokens = new Set<string>();
    while (true) {
      const suffix = token ? `&pager.page_token=${encodeURIComponent(token)}` : "";
      const response = await this.pageRequest(`${SERVICE}/vidu/v1/material/elements/personal?pager.pagesz=100${suffix}`, { method: "GET" });
      if (response.status === 401 || response.status === 403) throw new VideoApiError("authentication", "Vidu 登录已失效", response.status);
      if (isViduSubjectLimitFailure(response.body)) throw subjectLimitError(response.body, response.status);
      if (response.status !== 200) throw new VideoApiError("http", `读取 Vidu 主体库失败: HTTP ${response.status}`, response.status);
      const payload = json(response.body);
      if (!isObject(payload)) break;
      const elements = Array.isArray(payload.elements) ? payload.elements.filter(isObject) : [];
      output.push(...elements.filter((element) => element.type === "user"));
      const pager = isObject(payload.pager) ? payload.pager : null;
      const nextToken = pager && typeof pager.next_page_token === "string" ? pager.next_page_token : "";
      if (!nextToken || seenTokens.has(nextToken)) break;
      seenTokens.add(nextToken);
      token = nextToken;
    }
    return output;
  }

  private async listMaterials(): Promise<Map<string, ViduMaterial>> {
    const output = new Map<string, ViduMaterial>();
    const elements = await this.listPersonalSubjectElements();
    elements.forEach((element) => {
      if (typeof element.name !== "string") return;
        const components = Array.isArray(element.components) ? element.components.filter(isObject) : [];
        const first = components[0];
        const id = element.id === undefined ? "" : String(element.id);
        const url = first && typeof first.content === "string" ? first.content : "";
        if (id && url) output.set(element.name, {
          id,
          name: element.name,
          version: element.version === undefined ? "" : String(element.version),
          url,
          raw: element,
        });
    });
    return output;
  }

  async exportSubjectLibrary(): Promise<ViduSubjectClipboard> {
    return exclusiveViduAccountOperation(this.account.sessionKey.toLowerCase(), undefined, async () => {
      const elements = await this.listPersonalSubjectElements();
      const subjects = elements.map((element, subjectIndex) => {
        const sanitizedLabels = sanitizedClipboardJson(element.labels ?? []);
        const sanitizedVoice = sanitizedClipboardJson(element.voice ?? {});
        if (!Array.isArray(sanitizedLabels) || !isObject(sanitizedVoice)) {
          throw new Error(`Vidu 主体库第 ${subjectIndex + 1} 项元数据无效`);
        }
        const rawComponents = Array.isArray(element.components) ? element.components.filter(isObject) : [];
        return {
          name: clipboardString(element.name, `subjects[${subjectIndex}].name`, 240),
          labels: sanitizedLabels,
          voice: sanitizedVoice,
          modality: typeof element.modality === "string" && element.modality.trim() ? element.modality : "image",
          components: rawComponents.map((component, componentIndex) => {
            const selectedRegion = sanitizedClipboardJson(component.selected_region ?? {});
            if (!isObject(selectedRegion)) throw new Error(`Vidu 主体库第 ${subjectIndex + 1} 项组件 ${componentIndex + 1} 裁剪区域无效`);
            const normalized = {
              type: typeof component.type === "string" && component.type.trim() ? component.type : "main",
              contentType: typeof component.content_type === "string" && component.content_type.trim() ? component.content_type : "image",
              selectedRegion,
              contentUrl: clipboardUrl(component.content, `subjects[${subjectIndex}].components[${componentIndex}].content`),
              sourceImageUrl: clipboardUrl(component.src_img, `subjects[${subjectIndex}].components[${componentIndex}].src_img`),
            };
            if (!normalized.contentUrl && !normalized.sourceImageUrl) {
              throw new Error(`Vidu 主体“${String(element.name ?? subjectIndex + 1)}”的组件 ${componentIndex + 1} 没有可复制素材`);
            }
            return normalized;
          }),
        } satisfies ViduSubjectClipboardItem;
      });
      const invalid = subjects.find((subject) => subject.components.length === 0);
      if (invalid) throw new Error(`Vidu 主体“${invalid.name}”没有可复制素材组件`);
      return {
        version: 1,
        copiedAt: new Date().toISOString(),
        sourceAccountName: this.account.name,
        subjects,
      };
    });
  }

  private async downloadSubjectAsset(url: string): Promise<{ bytes: ArrayBuffer; contentType: string; width: number; height: number }> {
    const validatedUrl = clipboardUrl(url, "subject.asset");
    const response = await this.browserSession.fetch(validatedUrl, {
      method: "GET",
      headers: { Accept: "image/*" },
      redirect: "follow",
    });
    if (response.url) clipboardUrl(response.url, "subject.asset.redirect");
    if (!response.ok) throw new ViduMaterialOperationError("put", response.status, "download-failed", `下载主体素材失败: HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > SUBJECT_ASSET_MAX_BYTES) throw new Error("主体素材超过 30 MB 限制");
    const contentTypeValue = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (contentTypeValue && !contentTypeValue.startsWith("image/")) throw new Error(`主体素材不是图片: ${contentTypeValue}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) throw new Error("下载到的主体素材为空");
    if (bytes.byteLength > SUBJECT_ASSET_MAX_BYTES) throw new Error("主体素材超过 30 MB 限制");
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    const size = image.getSize();
    if (image.isEmpty() || size.width <= 0 || size.height <= 0) throw new Error("下载到的主体素材无法解码为图片");
    return { bytes, contentType: contentTypeValue || "image/jpeg", width: size.width, height: size.height };
  }

  private async uploadSubjectAsset(asset: { bytes: ArrayBuffer; contentType: string; width: number; height: number }): Promise<string> {
    const initialized = await this.jsonRequest(`${SERVICE}/tools/v1/files/uploads`, "POST", {
      metadata: { "image-height": String(asset.height), "image-width": String(asset.width) },
      scene: "material",
    });
    if (initialized.response.status < 200 || initialized.response.status >= 300 || !isObject(initialized.data)) {
      throw new ViduMaterialOperationError("upload", initialized.response.status, initialized.response.body, `Vidu 主体上传初始化失败: HTTP ${initialized.response.status}`);
    }
    const id = typeof initialized.data.id === "string" ? initialized.data.id : String(initialized.data.id ?? "");
    const putUrl = typeof initialized.data.put_url === "string" ? initialized.data.put_url : "";
    if (!id || !putUrl) throw new ViduMaterialOperationError("upload", initialized.response.status, initialized.response.body, "Vidu 主体上传初始化结果缺少 id 或 put_url");
    const putResponse = await this.browserSession.fetch(putUrl, {
      method: "PUT",
      headers: { "Content-Type": asset.contentType },
      body: asset.bytes,
    });
    if (!putResponse.ok) {
      const body = await putResponse.text().catch(() => "");
      throw new ViduMaterialOperationError("put", putResponse.status, body, `Vidu 主体文件上传失败: HTTP ${putResponse.status}`);
    }
    const etag = putResponse.headers.get("etag")?.replace(/"/g, "") ?? "";
    if (!etag) throw new ViduMaterialOperationError("put", putResponse.status, "missing-etag", "Vidu 主体文件上传未返回 ETag");
    const finished = await this.jsonRequest(`${SERVICE}/tools/v1/files/uploads/${encodeURIComponent(id)}/finish`, "PUT", { etag, id });
    if (finished.response.status < 200 || finished.response.status >= 300) {
      throw new ViduMaterialOperationError("finish", finished.response.status, finished.response.body, `Vidu 主体上传确认失败: HTTP ${finished.response.status}`);
    }
    return isObject(finished.data) && typeof finished.data.uri === "string" && finished.data.uri
      ? finished.data.uri
      : `ssupload:?id=${id}`;
  }

  private async importSubject(subject: ViduSubjectClipboardItem): Promise<void> {
    const components: JsonObject[] = [];
    for (const component of subject.components) {
      const [contentAsset, sourceImageAsset] = await Promise.all([
        component.contentUrl ? this.downloadSubjectAsset(component.contentUrl) : Promise.resolve(null),
        component.sourceImageUrl ? this.downloadSubjectAsset(component.sourceImageUrl) : Promise.resolve(null),
      ]);
      const [content, sourceImage] = await Promise.all([
        contentAsset ? this.uploadSubjectAsset(contentAsset) : Promise.resolve(""),
        sourceImageAsset ? this.uploadSubjectAsset(sourceImageAsset) : Promise.resolve(""),
      ]);
      components.push({
        type: component.type,
        content,
        src_img: sourceImage,
        content_type: component.contentType,
        selected_region: component.selectedRegion,
      });
    }
    const preprocessBody = {
      components,
      labels: subject.labels,
      name: subject.name,
      type: "user",
      voice: subject.voice,
    };
    const preprocessed = await this.jsonRequest(`${SERVICE}/vidu/v1/material/elements/pre-process`, "POST", preprocessBody);
    if (preprocessed.response.status < 200 || preprocessed.response.status >= 300 || !isObject(preprocessed.data) || !preprocessed.data.id) {
      throw new ViduMaterialOperationError("pre-process", preprocessed.response.status, preprocessed.response.body, `Vidu 主体预处理失败: HTTP ${preprocessed.response.status}`);
    }
    const created = await this.jsonRequest(`${SERVICE}/vidu/v1/material/elements`, "POST", {
      ...preprocessed.data,
      name: subject.name,
      labels: subject.labels,
      modality: subject.modality,
      voice: subject.voice,
      type: "user",
      components,
    });
    if (created.response.status < 200 || created.response.status >= 300) {
      throw new ViduMaterialOperationError("create", created.response.status, created.response.body, `Vidu 主体创建失败: HTTP ${created.response.status}`);
    }
  }

  async importSubjectLibrary(clipboard: ViduSubjectClipboard): Promise<ViduSubjectOperationResult> {
    const parsed = parseViduSubjectClipboard(clipboard);
    return exclusiveViduAccountOperation(this.account.sessionKey.toLowerCase(), undefined, async () => {
      const results = new Array<ViduSubjectOperationResult["results"][number]>(parsed.subjects.length);
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < parsed.subjects.length) {
          const index = cursor++;
          const subject = parsed.subjects[index];
          try {
            await this.importSubject(subject);
            results[index] = { name: subject.name, status: "success", message: "主体已创建" };
          } catch (error) {
            results[index] = { name: subject.name, status: "failed", message: redactViduJwt(error instanceof Error ? error.message : String(error)) };
          }
        }
      };
      const workerCount = Math.min(SUBJECT_IMPORT_CONCURRENCY, parsed.subjects.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      const success = results.filter((result) => result.status === "success").length;
      return { total: results.length, success, failed: results.length - success, results };
    });
  }

  async clearSubjectLibrary(): Promise<ViduSubjectOperationResult> {
    return exclusiveViduAccountOperation(this.account.sessionKey.toLowerCase(), undefined, async () => {
      const subjects = await this.listPersonalSubjectElements();
      const results: ViduSubjectOperationResult["results"] = [];
      for (const subject of subjects) {
        const name = typeof subject.name === "string" && subject.name.trim() ? subject.name : "未命名主体";
        const id = subject.id === undefined ? "" : String(subject.id);
        if (!id) {
          results.push({ name, status: "failed", message: "主体缺少 id，未删除" });
          continue;
        }
        const response = await this.pageRequest(`${SERVICE}/vidu/v1/material/elements/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (response.status >= 200 && response.status < 300) results.push({ name, status: "success", message: "主体已删除" });
        else results.push({ name, status: "failed", message: redactViduJwt(providerMessage(response.body, `删除失败: HTTP ${response.status}`)) });
      }
      const success = results.filter((result) => result.status === "success").length;
      return { total: results.length, success, failed: results.length - success, results };
    });
  }

  private async findAsset(projectDirectory: string, name: string): Promise<string | null> {
    return findCharacterAsset(projectDirectory, name);
  }

  private async uploadMaterial(name: string, imagePath: string, existing?: ViduMaterial): Promise<void> {
    const image = nativeImage.createFromPath(imagePath);
    const size = image.getSize();
    if (image.isEmpty() || size.width <= 0 || size.height <= 0) throw new Error(`主体素材无法读取: ${imagePath}`);
    const uploads: Array<{ id: string; put_url: string }> = [];
    for (let index = 0; index < 2; index += 1) {
      const { response, data } = await this.jsonRequest(`${SERVICE}/tools/v1/files/uploads`, "POST", {
        scene: "material",
        metadata: { "image-width": String(size.width), "image-height": String(size.height) },
      });
      if (response.status < 200 || response.status >= 300 || !isObject(data) || !data.id || !data.put_url) {
        if (isViduSubjectLimitFailure(response.body)) throw subjectLimitError(response.body, response.status);
        throw new ViduMaterialOperationError("upload", response.status, response.body, `Vidu 主体上传初始化失败: HTTP ${response.status}`);
      }
      uploads.push({ id: String(data.id), put_url: String(data.put_url) });
    }
    const bytes = await readFile(imagePath);
    const etags: string[] = [];
    for (const upload of uploads) {
      const response = await this.browserSession.fetch(upload.put_url, {
        method: "PUT",
        headers: { "Content-Type": contentType(imagePath) },
        body: bytes,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new ViduMaterialOperationError("put", response.status, body, `Vidu 主体文件上传失败: HTTP ${response.status}`);
      }
      const etag = response.headers.get("etag")?.replace(/"/g, "") ?? "";
      if (!etag) throw new ViduMaterialOperationError("put", response.status, "missing-etag", "Vidu 主体文件上传未返回 ETag");
      etags.push(etag);
    }
    for (let index = 0; index < uploads.length; index += 1) {
      const upload = uploads[index];
      const { response } = await this.jsonRequest(`${SERVICE}/tools/v1/files/uploads/${upload.id}/finish`, "PUT", {
        etag: etags[index], id: upload.id,
      });
      if (response.status < 200 || response.status >= 300) {
        if (isViduSubjectLimitFailure(response.body)) throw subjectLimitError(response.body, response.status);
        throw new ViduMaterialOperationError("finish", response.status, response.body, `Vidu 主体上传确认失败: HTTP ${response.status}`);
      }
    }
    await sleep(3_000);
    const components = [{
      type: "main",
      content: `ssupload:?id=${uploads[0].id}`,
      src_img: `ssupload:?id=${uploads[1].id}`,
      content_type: "image",
      selected_region: { top_left: { x: 0, y: 0 }, bottom_right: { x: size.width, y: size.height } },
    }];
    const preprocessBody: JsonObject = { components };
    if (existing) Object.assign(preprocessBody, { id: existing.id, name, type: "user", labels: [], voice: { id: "" } });
    const preprocessed = await this.jsonRequest(`${SERVICE}/vidu/v1/material/elements/pre-process`, "POST", preprocessBody);
    if (preprocessed.response.status !== 200 || !isObject(preprocessed.data)) {
      if (isViduSubjectLimitFailure(preprocessed.response.body)) {
        throw subjectLimitError(preprocessed.response.body, preprocessed.response.status);
      }
      throw new ViduMaterialOperationError(
        "pre-process",
        preprocessed.response.status,
        preprocessed.response.body,
        `Vidu 主体预处理失败: HTTP ${preprocessed.response.status}`,
      );
    }
    await sleep(2_000);
    if (existing) {
      const updated = await this.jsonRequest(`${SERVICE}/vidu/v1/material/elements/${existing.id}`, "PUT", {
        element: {
          name,
          labels: [],
          modality: "image",
          voice: { id: "", is_my: false },
          components,
          recaption: isObject(preprocessed.data.recaption) ? preprocessed.data.recaption : {},
        },
        mask: "name,components,labels,voice,recaption",
      });
      if (updated.response.status !== 200) {
        if (isViduSubjectLimitFailure(updated.response.body)) throw subjectLimitError(updated.response.body, updated.response.status);
        throw new ViduMaterialOperationError("edit", updated.response.status, updated.response.body, `Vidu 主体覆盖失败: HTTP ${updated.response.status}`);
      }
      return;
    }
    const created = await this.jsonRequest(`${SERVICE}/vidu/v1/material/elements`, "POST", {
      ...preprocessed.data,
      name,
      modality: "image",
      labels: [],
    });
    if (created.response.status !== 200) {
      if (isViduSubjectLimitFailure(created.response.body)) throw subjectLimitError(created.response.body, created.response.status);
      throw new ViduMaterialOperationError("create", created.response.status, created.response.body, `Vidu 主体创建失败: HTTP ${created.response.status}`);
    }
  }

  private async uploadMaterialWithRetry(
    name: string,
    imagePath: string,
    existing: ViduMaterial | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MATERIAL_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.uploadMaterial(name, imagePath, existing);
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof VideoApiError || /主体素材无法读取/u.test(error instanceof Error ? error.message : "")) throw error;
        const delay = error instanceof ViduMaterialOperationError
          ? viduMaterialRetryDelay(error.stage, error.status, error.body, attempt)
          : MATERIAL_RETRY_DELAY_MS;
        if (delay === null || attempt >= MATERIAL_MAX_ATTEMPTS) throw error;
        await sleep(delay, signal);
      }
    }
    throw lastError;
  }

  private async replacementVictim(
    materials: Map<string, ViduMaterial>,
    neededNow: ReadonlySet<string>,
    request: ViduSubmitRequest,
  ): Promise<ViduMaterial | null> {
    const candidates: ViduReplacementCandidate[] = [];
    for (const material of materials.values()) {
      candidates.push({
        material,
        belongsToProject: Boolean(await this.findAsset(request.projectDirectory, material.name)),
        nextAppearance: request.nextSubjectAppearances?.[material.name] ?? null,
      });
    }
    return chooseViduReplacementCandidate(candidates, neededNow);
  }

  private async prepareMaterials(request: ViduSubmitRequest, options: ViduSubmitOptions): Promise<ViduMaterial[]> {
    const { signal } = options;
    const roles = extractViduRoleNames(request.prompt);
    if (roles.length === 0) return [];
    let materials = await this.listMaterials();
    const plans = await Promise.all(roles.map(async (name) => {
      const asset = await this.findAsset(request.projectDirectory, name);
      const existing = materials.get(name);
      if (!asset) return { name, asset, existing, fingerprint: null, key: null, needsPreparation: false };
      const fingerprint = await fingerprintViduAsset(asset);
      const key = `${request.projectDirectory}\u0000${name}`;
      const cached = this.materialCache?.get(this.account.id, request.projectId, name);
      const remoteMatches = existing
        && cached
        && existing.id === cached.materialId
        && existing.version === cached.version
        && existing.url === cached.contentUrl;
      const needsPreparation = this.preparedAssets.get(key) !== fingerprint
        && (!cached || cached.assetFingerprint !== fingerprint || !remoteMatches);
      return { name, asset, existing, fingerprint, key, needsPreparation };
    }));
    const preparationTotal = plans.filter(({ needsPreparation }) => needsPreparation).length;
    let preparationIndex = 0;
    const preparationPlans = plans.filter(({ needsPreparation }) => needsPreparation);
    if (preparationTotal > 0) {
      options.onSubjectPreparation?.({
        phase: "start",
        current: 0,
        total: preparationTotal,
        name: preparationPlans[0]?.name ?? "",
      });
    }
    try {
      for (const plan of plans) {
        if (signal?.aborted) throw signal.reason;
        const { name, asset, existing, fingerprint, key, needsPreparation } = plan;
        if (asset && fingerprint && key && needsPreparation) {
          options.onSubjectPreparation?.({
            phase: "progress",
            current: preparationIndex,
            total: preparationTotal,
            name,
          });
          try {
            await this.uploadMaterialWithRetry(name, asset, existing, signal);
          } catch (error) {
            const canReplace = !existing
              && error instanceof ViduMaterialOperationError
              && error.stage === "create"
              && viduMaterialRetryDelay(error.stage, error.status, error.body, MATERIAL_MAX_ATTEMPTS) === null;
            if (!canReplace) throw error;
            const victim = await this.replacementVictim(materials, new Set(roles), request);
            if (!victim) throw new Error(`Vidu 主体库已满，且当前分镜没有可安全覆盖的主体`, { cause: error });
            await this.uploadMaterialWithRetry(name, asset, victim, signal);
            this.preparedAssets.delete(`${request.projectDirectory}\u0000${victim.name}`);
          }
          this.preparedAssets.set(key, fingerprint);
          const nextPreparationIndex = preparationIndex + 1;
          const gapMs = viduSubjectPreparationGapMs(nextPreparationIndex, preparationTotal);
          if (gapMs > 0) await sleep(gapMs, signal);
          materials = await this.waitForMaterial(name, signal);
          const prepared = materials.get(name);
          if (prepared) this.materialCache?.upsert({
            accountId: this.account.id,
            projectId: request.projectId,
            name,
            assetFingerprint: fingerprint,
            materialId: prepared.id,
            version: prepared.version,
            contentUrl: prepared.url,
          });
          preparationIndex = nextPreparationIndex;
          options.onSubjectPreparation?.({
            phase: "progress",
            current: preparationIndex,
            total: preparationTotal,
            name,
          });
        }
        if (!materials.has(name)) {
          throw new Error(`Vidu 主体库缺少“${name}”，并且项目“资产图”目录中没有同名图片`);
        }
      }
    } finally {
      if (preparationTotal > 0) {
        options.onSubjectPreparation?.({
          phase: "end",
          current: preparationIndex,
          total: preparationTotal,
          name: preparationPlans[Math.min(preparationIndex, preparationTotal - 1)]?.name ?? "",
        });
      }
    }
    return roles.map((name) => materials.get(name)!);
  }

  private async waitForMaterial(name: string, signal?: AbortSignal): Promise<Map<string, ViduMaterial>> {
    const deadline = Date.now() + 30_000;
    let materials = new Map<string, ViduMaterial>();
    while (Date.now() < deadline) {
      materials = await this.listMaterials();
      if (materials.has(name)) return materials;
      await sleep(2_000, signal);
    }
    throw new Error(`Vidu 主体“${name}”上传后尚未就绪`);
  }

  async submit(request: ViduSubmitRequest, options: ViduSubmitOptions = {}): Promise<{ taskId: string; raw: unknown }> {
    const preparedRequest = { ...request, prompt: bindViduSubjects(request.prompt, request.subjects) };
    return exclusiveViduAccountOperation(this.account.sessionKey.toLowerCase(), options.signal, async () => {
      const status = await this.status();
      if (status.status !== "logged-in") throw new VideoApiError("authentication", status.message);
      await this.preflightCredits(preparedRequest);
      const materials = await this.prepareMaterials(preparedRequest, options);
      const payload = buildViduCharacterPayload({ ...preparedRequest, materials });
      const throttleProbeMs = Number.isFinite(options.throttleProbeMs) && (options.throttleProbeMs ?? 0) > 0
        ? Math.max(1, Math.round(options.throttleProbeMs!))
        : DEFAULT_THROTTLE_PROBE_MS;
      const submitRetryMs = Number.isFinite(options.throttleProbeMs) && (options.throttleProbeMs ?? 0) > 0
        ? Math.max(1, Math.round(options.throttleProbeMs!))
        : DEFAULT_SUBMIT_RETRY_MS;
      const deadline = Date.now() + SUBMIT_WATCHDOG_MS;
      const remaining = (): number => deadline - Date.now();
      const ensureWithinDeadline = (): void => {
        if (remaining() <= 0) throw new VideoApiError("timeout", "Vidu submission timed out after 300 seconds");
      };
      let throttled = false;
      const markThrottled = (reason: "in_progress" | "rate_limit", inProgress: number | null, retryInMs: number): void => {
        if (throttled) return;
        throttled = true;
        options.onThrottled?.({ reason, inProgress, retryInMs });
      };
      const waitUntilCapacity = async (): Promise<void> => {
        for (;;) {
          throwIfCancelled(options.signal);
          ensureWithinDeadline();
          const inProgress = await this.countInProgress();
          if (inProgress < 100) {
            if (throttled) {
              throttled = false;
              options.onThrottleRecovered?.({ inProgress });
            }
            return;
          }
          markThrottled("in_progress", inProgress, throttleProbeMs);
          await waitForThrottle(Math.min(throttleProbeMs, Math.max(1, remaining())), options.signal);
        }
      };

      await waitUntilCapacity();
      const before = new Set(viduTasks(await this.history(5)).map(extractViduTaskId).filter((id): id is string => Boolean(id)));
      for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt += 1) {
        throwIfCancelled(options.signal);
        ensureWithinDeadline();
        const response = await this.pageRequest(`${SERVICE}/vidu/v1/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const raw = json(response.body);
        if (response.status === 200) {
          let taskId = extractViduSubmittedTaskId(raw);
          if (taskId) return { taskId, raw };
          const candidate = extractViduTaskId(raw);
          const after = viduTasks(await this.history(5)).map(extractViduTaskId).filter((id): id is string => Boolean(id));
          const added = [...new Set(after.filter((id) => !before.has(id)))];
          if (candidate && after.includes(candidate)) taskId = candidate;
          else if (added.length === 1) taskId = added[0];
          if (taskId) return { taskId, raw };
          throw new VideoApiError("invalid_response", "Vidu 已接受提交但未能确定 task_id，请先在 Vidu 任务历史中确认，避免重复扣费", 200, undefined, raw);
        }
        if (response.status === 401) throw new VideoApiError("authentication", "Vidu 登录已失效", response.status);
        if (isViduSubjectLimitFailure(response.body)) throw subjectLimitError(response.body, response.status);
        if (response.status === 429 && !isViduQuotaFailure(response.body)) {
          if (attempt >= SUBMIT_MAX_ATTEMPTS) {
            throw new VideoApiError("rate_limit", providerMessage(response.body, "Vidu submission rate limited after 3 attempts"), response.status);
          }
          markThrottled("rate_limit", null, submitRetryMs);
          await waitForThrottle(Math.min(submitRetryMs, Math.max(1, remaining())), options.signal);
          await waitUntilCapacity();
          continue;
        }
        if (response.status === 0 || response.status >= 500) {
          throw new VideoApiError("invalid_response", `Vidu 提交结果不确定: HTTP ${response.status}，请先检查网站任务历史`, response.status);
        }
        if (isViduQuotaFailure(response.body) || isViduPlanLimitFailure(response.body)) {
          throw new VideoApiError("rate_limit", providerMessage(response.body, "Vidu 额度或套餐当前不可用"), response.status);
        }
        throw new VideoApiError(response.status === 429 ? "rate_limit" : "http", providerMessage(response.body, `Vidu 提交失败: HTTP ${response.status}`), response.status);
      }
      throw new VideoApiError("rate_limit", "Vidu submission rate limited after 3 attempts", 429);
    });
  }

  async poll(taskId: string, options: { signal?: AbortSignal } = {}): Promise<VideoTaskStatus> {
    if (options.signal?.aborted) throw new VideoApiError("cancelled", "Vidu 任务查询已取消");
    const taskUrl = `${SERVICE}/vidu/v1/tasks/${encodeURIComponent(taskId)}`;
    let response = await this.sessionRequest(taskUrl, { method: "GET" }, options.signal);
    if (response.status === 0) {
      const sessionFailure = response.body;
      try {
        response = await this.pageRequest(taskUrl, { method: "GET" });
      } catch (error) {
        const pageFailure = error instanceof Error ? error.message : String(error);
        response = { status: 0, body: `${sessionFailure}; page fallback: ${pageFailure}` };
      }
    }
    if (response.status === 401) throw new VideoApiError("authentication", "Vidu 登录已失效", response.status);
    if (response.status === 403 || response.status === 404) {
      const historyTask = await this.findTaskInSessionHistory(taskId, options.signal);
      if (historyTask) return normalizeViduTask(taskId, historyTask);
      throw new VideoApiError("not_found", "Vidu 网站和任务历史中均未找到该任务", 404);
    }
    if (response.status === 0 || response.status === 429 || response.status >= 500) {
      const detail = response.status === 0 ? providerMessage(response.body, "网络请求未收到响应") : `HTTP ${response.status}`;
      throw new VideoApiError("unavailable", `Vidu 任务服务暂不可用: ${detail}`, response.status);
    }
    if (response.status !== 200) throw new VideoApiError("http", `查询 Vidu 任务失败: HTTP ${response.status}`, response.status);
    return normalizeViduTask(taskId, json(response.body));
  }

  async waitForResult(
    taskId: string,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      pollIntervalMs?: number;
      onProgress?: (status: VideoTaskStatus) => void;
    } = {},
  ): Promise<VideoTaskStatus & { phase: "succeeded"; resultUrl: string }> {
    const timeoutMs = options.timeoutMs ?? 30 * 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    let transientFailures = 0;
    while (Date.now() < deadline) {
      let status: VideoTaskStatus;
      try {
        status = await this.poll(taskId, { signal: options.signal });
        transientFailures = 0;
      } catch (error) {
        if (!(error instanceof VideoApiError) || error.kind !== "unavailable") throw error;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        transientFailures += 1;
        const retryDelayMs = Math.min(
          remainingMs,
          15_000,
          pollIntervalMs * (2 ** Math.min(transientFailures - 1, 3)),
        );
        await sleep(Math.max(1, retryDelayMs), options.signal);
        continue;
      }
      options.onProgress?.(status);
      if (status.phase === "succeeded" && status.resultUrl) return { ...status, phase: "succeeded", resultUrl: status.resultUrl };
      if (status.phase === "failed") throw new VideoApiError("provider_failed", status.error ?? "Vidu 生成失败", undefined, undefined, status.raw);
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), options.signal);
    }
    throw new VideoApiError("timeout", `Vidu 任务等待超过 ${Math.round(timeoutMs / 1000)} 秒`);
  }

  async downloadResult(
    resultUrl: string,
    options: { outputDirectory: string; stem: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number },
  ): Promise<{ path: string; bytes: number; mimeType: string | null }> {
    const client = new AsyncVideoTaskClient({
      baseUrl: SERVICE,
      fetch: sessionFetch(this.browserSession),
      requestTimeoutMs: options.timeoutMs,
    });
    return client.downloadResult(resultUrl, options);
  }
}

export class ViduBrowserManager {
  private readonly clients = new Map<string, ViduBrowserClient>();
  private readonly loginStatusCache = new Map<string, { sessionKey: string; expiresAt: number; status: ViduAccountStatus }>();
  private readonly loginStatusChecks = new Map<string, { sessionKey: string; check: Promise<ViduAccountStatus> }>();
  private readonly loginStatusGenerations = new Map<string, number>();

  constructor(private readonly materialCache?: ViduMaterialCacheRepository) {}

  private invalidateLoginStatus(accountId: string): void {
    this.loginStatusCache.delete(accountId);
    this.loginStatusChecks.delete(accountId);
    this.loginStatusGenerations.set(accountId, (this.loginStatusGenerations.get(accountId) ?? 0) + 1);
  }

  client(account: ViduAccount): ViduBrowserClient {
    const existing = this.clients.get(account.id);
    if (existing && existing.account.sessionKey === account.sessionKey) return existing;
    existing?.dispose();
    if (existing) this.invalidateLoginStatus(account.id);
    const client = new ViduBrowserClient(account, this.materialCache);
    this.clients.set(account.id, client);
    return client;
  }

  async openLogin(account: ViduAccount): Promise<void> {
    this.invalidateLoginStatus(account.id);
    await this.client(account).openLogin();
  }

  async checkLogin(account: ViduAccount): Promise<ViduAccountStatus> {
    const cached = this.loginStatusCache.get(account.id);
    if (cached && cached.sessionKey === account.sessionKey && cached.expiresAt > Date.now()) return cached.status;
    const inFlight = this.loginStatusChecks.get(account.id);
    if (inFlight?.sessionKey === account.sessionKey) return inFlight.check;
    if (inFlight) this.invalidateLoginStatus(account.id);
    const client = this.client(account);
    const generation = this.loginStatusGenerations.get(account.id) ?? 0;
    let check!: Promise<ViduAccountStatus>;
    check = client.status()
      .then((status) => {
        if ((this.loginStatusGenerations.get(account.id) ?? 0) !== generation) return status;
        if (status.status === "logged-in") {
          this.loginStatusCache.set(account.id, {
            sessionKey: account.sessionKey,
            expiresAt: Date.now() + LOGIN_STATUS_TTL_MS,
            status,
          });
        } else {
          this.loginStatusCache.delete(account.id);
        }
        return status;
      })
      .finally(() => {
        if (this.loginStatusChecks.get(account.id)?.check === check) this.loginStatusChecks.delete(account.id);
      });
    this.loginStatusChecks.set(account.id, { sessionKey: account.sessionKey, check });
    return check;
  }

  async loginWithJwt(account: ViduAccount, jwt: string, ssuid?: string): Promise<ViduAccountStatus> {
    this.invalidateLoginStatus(account.id);
    const client = this.client(account);
    const generation = this.loginStatusGenerations.get(account.id) ?? 0;
    const status = await client.loginWithJwt(jwt, ssuid);
    if (status.status === "logged-in" && (this.loginStatusGenerations.get(account.id) ?? 0) === generation) {
      this.loginStatusCache.set(account.id, {
        sessionKey: account.sessionKey,
        expiresAt: Date.now() + LOGIN_STATUS_TTL_MS,
        status,
      });
    }
    return status;
  }

  async clearSession(account: ViduAccount): Promise<void> {
    this.invalidateLoginStatus(account.id);
    await this.client(account).clearSession();
  }

  async exportSubjectLibrary(account: ViduAccount): Promise<ViduSubjectClipboard> {
    return this.client(account).exportSubjectLibrary();
  }

  async importSubjectLibrary(account: ViduAccount, clipboard: ViduSubjectClipboard): Promise<ViduSubjectOperationResult> {
    return this.client(account).importSubjectLibrary(clipboard);
  }

  async clearSubjectLibrary(account: ViduAccount): Promise<ViduSubjectOperationResult> {
    return this.client(account).clearSubjectLibrary();
  }

  closeAccount(accountId: string): void {
    this.clients.get(accountId)?.dispose();
    this.clients.delete(accountId);
    this.invalidateLoginStatus(accountId);
  }

  dispose(): void {
    this.clients.forEach((client) => client.dispose());
    this.clients.clear();
    this.loginStatusCache.clear();
    this.loginStatusChecks.clear();
    this.loginStatusGenerations.clear();
  }
}
