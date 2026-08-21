import { ModelApiError, type GeneratedImage, type ImagesResult, type ModelRequestOptions } from "./model-clients";

type GeminiClientOptions = {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

type GeminiImageRequest = {
  model: string;
  prompt: string;
  aspectRatio?: string;
  referenceImages?: Array<{ mimeType: string; base64: string }>;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function imageEndpoint(baseUrl: string, model: string): string {
  if (!baseUrl.trim()) throw new ModelApiError("configuration", "Gemini API baseUrl is required");
  if (!model.trim()) throw new ModelApiError("configuration", "Gemini image model is required");
  try {
    return new URL(
      `models/${encodeURIComponent(model.trim())}:generateContent`,
      `${baseUrl.trim().replace(/\/+$/, "")}/`,
    ).toString();
  } catch (cause) {
    throw new ModelApiError("configuration", `Invalid Gemini API baseUrl: ${baseUrl}`, undefined, undefined, undefined, {
      cause,
    });
  }
}

function providerMessage(body: unknown, fallback: string): string {
  if (!isObject(body)) return fallback;
  const error = body.error;
  if (isObject(error) && typeof error.message === "string") return error.message;
  return fallback;
}

function statusKind(status: number): "authentication" | "rate_limit" | "server" | "http" {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "http";
}

export class GeminiImageClient {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: GeminiClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!this.fetcher) throw new ModelApiError("configuration", "No fetch implementation is available");
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new ModelApiError("configuration", "Gemini timeoutMs must be greater than zero");
    }
  }

  async images(request: GeminiImageRequest, options?: ModelRequestOptions): Promise<ImagesResult> {
    const controller = new AbortController();
    let timedOut = false;
    const cancel = (): void => controller.abort(options?.signal?.reason ?? new Error("Request cancelled"));
    if (options?.signal?.aborted) cancel();
    else options?.signal?.addEventListener("abort", cancel, { once: true });
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const response = await this.fetcher(imageEndpoint(this.options.baseUrl, request.model), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.options.apiKey ? { "x-goog-api-key": this.options.apiKey } : {}),
        },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: request.prompt },
              ...(request.referenceImages ?? []).map((image) => ({
                inlineData: { mimeType: image.mimeType, data: image.base64 },
              })),
            ],
          }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            ...(request.aspectRatio ? { imageConfig: { aspectRatio: request.aspectRatio } } : {}),
          },
        }),
        signal: controller.signal,
      });
      const rawText = await response.text();
      let body: unknown;
      try {
        body = rawText ? (JSON.parse(rawText) as unknown) : null;
      } catch (cause) {
        throw new ModelApiError("invalid_response", "Gemini API returned invalid JSON", response.status, undefined, rawText, {
          cause,
        });
      }
      if (!response.ok) {
        throw new ModelApiError(
          statusKind(response.status),
          providerMessage(body, `Gemini API request failed with HTTP ${response.status}`),
          response.status,
          response.headers.get("x-request-id") ?? undefined,
          body,
        );
      }
      const images = this.extractImages(body);
      if (images.length === 0) {
        throw new ModelApiError("invalid_response", "Gemini response does not contain image data", undefined, undefined, body);
      }
      return { images, raw: body };
    } catch (error) {
      if (error instanceof ModelApiError) throw error;
      if (timedOut) throw new ModelApiError("timeout", `Gemini API request timed out after ${timeoutMs}ms`, undefined, undefined, undefined, { cause: error });
      if (options?.signal?.aborted) throw new ModelApiError("cancelled", "Gemini API request was cancelled", undefined, undefined, undefined, { cause: error });
      throw new ModelApiError("network", "Gemini API network request failed", undefined, undefined, undefined, { cause: error });
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", cancel);
    }
  }

  private extractImages(body: unknown): GeneratedImage[] {
    if (!isObject(body) || !Array.isArray(body.candidates)) return [];
    const images: GeneratedImage[] = [];
    for (const candidate of body.candidates) {
      if (!isObject(candidate) || !isObject(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
      for (const part of candidate.content.parts) {
        if (!isObject(part)) continue;
        const inline = isObject(part.inlineData) ? part.inlineData : isObject(part.inline_data) ? part.inline_data : null;
        if (inline && typeof inline.data === "string") {
          images.push({
            url: null,
            base64: inline.data,
            revisedPrompt: null,
            mimeType:
              typeof inline.mimeType === "string"
                ? inline.mimeType
                : typeof inline.mime_type === "string"
                  ? inline.mime_type
                  : null,
          });
        }
      }
    }
    return images;
  }
}
