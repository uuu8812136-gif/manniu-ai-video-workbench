import { openAICompatibleEndpoint } from "./openai-endpoint";
import { imageProviderCompatibilityError } from "./image-provider";

export type ModelProbeProvider = "openai" | "gemini";

export type ModelProbeResult = {
  ok: boolean;
  provider: ModelProbeProvider;
  status: number | null;
  latencyMs: number;
  models: string[];
  message: string;
};

type ProbeInput = {
  provider: ModelProbeProvider;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probeUrl(input: ProbeInput): string {
  const base = input.baseUrl.trim();
  if (!base) throw new Error("API 地址不能为空");
  if (input.provider === "openai") return openAICompatibleEndpoint(base, "models");
  const path = input.provider === "gemini" && input.model?.trim()
    ? `models/${encodeURIComponent(input.model.trim())}`
    : "models";
  return new URL(path, `${base.replace(/\/+$/, "")}/`).toString();
}

function modelIds(body: unknown): string[] {
  if (!isObject(body)) return [];
  const values = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  return values
    .filter(isObject)
    .map((item) => (typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : null))
    .filter((value): value is string => Boolean(value));
}

function errorMessage(body: unknown, status: number): string {
  if (isObject(body) && isObject(body.error) && typeof body.error.message === "string") return body.error.message;
  return `接口返回 HTTP ${status}`;
}

export async function probeModelConnection(input: ProbeInput): Promise<ModelProbeResult> {
  const started = Date.now();
  const compatibilityError = input.model
    ? imageProviderCompatibilityError(input.provider, input.model)
    : null;
  if (compatibilityError) {
    return {
      ok: false,
      provider: input.provider,
      status: null,
      latencyMs: Date.now() - started,
      models: [],
      message: compatibilityError,
    };
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs ?? 15_000, 60_000));
  const timer = setTimeout(() => controller.abort(new Error("Connection test timed out")), timeoutMs);
  try {
    const response = await (input.fetch ?? globalThis.fetch)(probeUrl(input), {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(input.apiKey
          ? input.provider === "gemini"
            ? { "x-goog-api-key": input.apiKey }
            : { authorization: `Bearer ${input.apiKey}` }
          : {}),
      },
      signal: controller.signal,
    });
    const raw = await response.text();
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        const contentType = response.headers.get("content-type")?.toLowerCase() || "";
        const looksLikeHtml = contentType.includes("text/html") || /^\s*</u.test(raw);
        return {
          ok: false,
          provider: input.provider,
          status: response.status,
          latencyMs: Date.now() - started,
          models: [],
          message: looksLikeHtml
            ? "接口返回网页而非 JSON，请检查 API 地址是否需要 /v1，并确认服务协议"
            : "接口未返回有效 JSON",
        };
      }
    }
    const models = modelIds(body);
    return {
      ok: response.ok,
      provider: input.provider,
      status: response.status,
      latencyMs: Date.now() - started,
      models,
      message: response.ok ? "接口和鉴权可访问" : errorMessage(body, response.status),
    };
  } catch (error) {
    return {
      ok: false,
      provider: input.provider,
      status: null,
      latencyMs: Date.now() - started,
      models: [],
      message: controller.signal.aborted
        ? `连接测试在 ${timeoutMs}ms 后超时`
        : error instanceof Error
          ? error.message
          : "连接失败",
    };
  } finally {
    clearTimeout(timer);
  }
}
