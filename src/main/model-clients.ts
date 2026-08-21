import { openAICompatibleEndpoint } from "./openai-endpoint";

export type ModelErrorKind =
  | "configuration"
  | "timeout"
  | "cancelled"
  | "network"
  | "authentication"
  | "rate_limit"
  | "server"
  | "http"
  | "invalid_response";

export class ModelApiError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly status?: number,
    readonly requestId?: string,
    readonly responseBody?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelApiError";
  }
}

export type OpenAIClientOptions = {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  streamInactivityTimeoutMs?: number;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
};

export type ModelStreamProgress = {
  reasoningCharacters: number;
  textCharacters: number;
  reasoningDelta: string;
  textDelta: string;
};

export type ModelRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  streamInactivityTimeoutMs?: number;
  onStream?: (progress: ModelStreamProgress) => void;
};

export type ResponsesRequest = {
  model: string;
  input: unknown;
  instructions?: string;
  temperature?: number;
  max_output_tokens?: number;
  [key: string]: unknown;
};

export type ChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: unknown;
  [key: string]: unknown;
};

export type ChatCompletionsRequest = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
};

export type ImagesRequest = {
  model?: string;
  prompt: string;
  size?: string;
  quality?: string;
  n?: number;
  response_format?: "url" | "b64_json";
  [key: string]: unknown;
};

export type TextModelResult = {
  text: string;
  id: string | null;
  model: string | null;
  usage: unknown;
  raw: unknown;
};

export type GeneratedImage = {
  url: string | null;
  base64: string | null;
  revisedPrompt: string | null;
  mimeType?: string | null;
};

export type ImagesResult = {
  images: GeneratedImage[];
  raw: unknown;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ModelApiError("configuration", `timeoutMs must be greater than zero, received ${value}`);
  }
  return value;
}

function endpoint(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new ModelApiError("configuration", "Model API baseUrl is required");
  try {
    return openAICompatibleEndpoint(trimmed, path);
  } catch (cause) {
    throw new ModelApiError("configuration", `Invalid model API baseUrl: ${baseUrl}`, undefined, undefined, undefined, {
      cause,
    });
  }
}

function combineAbort(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  abort: (reason?: unknown) => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason ?? new Error("Request cancelled"));
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    abort: (reason) => controller.abort(reason),
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function errorKindForStatus(status: number): ModelErrorKind {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "http";
}

function providerErrorMessage(body: unknown, fallback: string): string {
  if (!isObject(body)) return fallback;
  const nested = body.error;
  if (typeof nested === "string") return nested;
  if (isObject(nested) && typeof nested.message === "string") return nested.message;
  if (typeof body.message === "string") return body.message;
  return fallback;
}

function textFromResponses(body: JsonObject): string | null {
  if (typeof body.output_text === "string" && body.output_text.length > 0) return body.output_text;
  if (!Array.isArray(body.output)) return null;
  const chunks: string[] = [];
  for (const output of body.output) {
    if (!isObject(output) || !Array.isArray(output.content)) continue;
    for (const part of output.content) {
      if (isObject(part) && typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.length > 0 ? chunks.join("") : null;
}

function textFromChat(body: JsonObject): string | null {
  const choices = body.choices;
  if (!Array.isArray(choices) || !isObject(choices[0]) || !isObject(choices[0].message)) return null;
  const content = choices[0].message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const chunks = content
    .filter(isObject)
    .map((part) => part.text)
    .filter((text): text is string => typeof text === "string");
  return chunks.length > 0 ? chunks.join("") : null;
}

function chatFinishReason(body: JsonObject): unknown {
  const choices = body.choices;
  return Array.isArray(choices) && isObject(choices[0]) ? choices[0].finish_reason : null;
}

function throwIfChatOutputWasTruncated(body: JsonObject, requestId?: string): void {
  if (chatFinishReason(body) !== "length") return;
  throw new ModelApiError(
    "invalid_response",
    "Model API output was truncated (finish_reason=length); reduce the requested output or use a model with a larger output limit",
    undefined,
    requestId,
    { finishReason: "length" },
  );
}

function throwIfResponsesOutputWasIncomplete(body: JsonObject, requestId?: string): void {
  const status = body.status;
  if (status === undefined || status === null || status === "completed") return;
  const detail = isObject(body.incomplete_details) ? body.incomplete_details : null;
  const reason = typeof detail?.reason === "string" ? detail.reason : String(status);
  throw new ModelApiError(
    "invalid_response",
    `Responses API did not complete (${reason}); partial output was not saved`,
    undefined,
    requestId,
    body,
  );
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(isObject)
    .map((part) => part.text)
    .filter((text): text is string => typeof text === "string")
    .join("");
}

function parseJson(raw: string, status: number, requestId?: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new ModelApiError(
      "invalid_response",
      `Model API returned invalid JSON (HTTP ${status})`,
      status,
      requestId,
      raw,
      { cause },
    );
  }
}

function parseJsonOrRaw(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
}

function sseData(event: string): string | null {
  const lines = event.split("\n");
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return data.length > 0 ? data.join("\n") : null;
}

export class OpenAIModelClient {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly streamInactivityTimeoutMs: number;

  constructor(private readonly options: OpenAIClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (!this.fetcher) throw new ModelApiError("configuration", "No fetch implementation is available");
    this.timeoutMs = requiredTimeout(options.timeoutMs ?? 1_800_000);
    this.streamInactivityTimeoutMs = requiredTimeout(options.streamInactivityTimeoutMs ?? 120_000);
    endpoint(options.baseUrl, "health-check");
  }

  async responses(request: ResponsesRequest, options?: ModelRequestOptions): Promise<TextModelResult> {
    if (request.stream === true) return this.streamResponses(request, options);
    const body = await this.post("responses", request, options);
    if (!isObject(body)) throw new ModelApiError("invalid_response", "Responses API returned a non-object body");
    throwIfResponsesOutputWasIncomplete(body);
    const text = textFromResponses(body);
    if (text === null) {
      throw new ModelApiError("invalid_response", "Responses API response does not contain output text", undefined, undefined, body);
    }
    return {
      text,
      id: typeof body.id === "string" ? body.id : null,
      model: typeof body.model === "string" ? body.model : null,
      usage: body.usage ?? null,
      raw: body,
    };
  }

  private async streamResponses(
    request: ResponsesRequest,
    requestOptions?: ModelRequestOptions,
  ): Promise<TextModelResult> {
    const timeoutMs = requiredTimeout(requestOptions?.timeoutMs ?? this.timeoutMs);
    const inactivityTimeoutMs = requiredTimeout(
      requestOptions?.streamInactivityTimeoutMs ?? this.streamInactivityTimeoutMs,
    );
    const abort = combineAbort(requestOptions?.signal, timeoutMs);
    let inactivityTimedOut = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await awaitWithAbort(
        this.fetcher(endpoint(this.options.baseUrl, "responses"), {
          method: "POST",
          headers: this.headers("text/event-stream"),
          body: JSON.stringify(request),
          signal: abort.signal,
        }),
        abort.signal,
      );
      const requestId = response.headers.get("x-request-id") ?? undefined;
      if (!response.ok || !isEventStream(response) || !response.body) {
        const raw = await awaitWithAbort(response.text(), abort.signal);
        if (!response.ok) {
          const parsed = parseJsonOrRaw(raw);
          throw new ModelApiError(
            errorKindForStatus(response.status),
            providerErrorMessage(parsed, `Model API request failed with HTTP ${response.status}`),
            response.status,
            requestId,
            parsed,
          );
        }
        const parsed = parseJson(raw, response.status, requestId);
        if (!isObject(parsed)) throw new ModelApiError("invalid_response", "Responses API returned a non-object body");
        throwIfResponsesOutputWasIncomplete(parsed, requestId);
        const text = textFromResponses(parsed);
        if (text === null) {
          throw new ModelApiError("invalid_response", "Responses API response does not contain output text", undefined, requestId, parsed);
        }
        requestOptions?.onStream?.({ reasoningCharacters: 0, textCharacters: text.length, reasoningDelta: "", textDelta: text });
        return {
          text,
          id: typeof parsed.id === "string" ? parsed.id : null,
          model: typeof parsed.model === "string" ? parsed.model : null,
          usage: parsed.usage ?? null,
          raw: parsed,
        };
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let pendingCarriageReturn = false;
      let text = "";
      let id: string | null = null;
      let model: string | null = null;
      let usage: unknown = null;
      let terminal = false;
      let terminalBody: JsonObject | null = null;

      const consume = (data: string): void => {
        if (!data || data === "[DONE]") return;
        const parsed = parseJson(data, response.status, requestId);
        if (!isObject(parsed)) return;
        const type = typeof parsed.type === "string" ? parsed.type : "";
        if (parsed.error !== undefined || type === "error") {
          throw new ModelApiError("http", providerErrorMessage(parsed, "Responses API stream returned an error"), undefined, requestId, parsed);
        }
        if (type === "response.incomplete" || type === "response.failed" || type === "response.cancelled") {
          const failed = isObject(parsed.response) ? parsed.response : parsed;
          throwIfResponsesOutputWasIncomplete(failed, requestId);
          throw new ModelApiError("invalid_response", `Responses API stream ended with ${type}`, undefined, requestId, parsed);
        }
        if (type === "response.output_text.delta" && typeof parsed.delta === "string") {
          text += parsed.delta;
          requestOptions?.onStream?.({
            reasoningCharacters: 0,
            textCharacters: text.length,
            reasoningDelta: "",
            textDelta: parsed.delta,
          });
          return;
        }
        if (type !== "response.completed") return;
        terminalBody = isObject(parsed.response) ? parsed.response : parsed;
        throwIfResponsesOutputWasIncomplete(terminalBody, requestId);
        const completedText = textFromResponses(terminalBody);
        if (completedText !== null) text = completedText;
        if (typeof terminalBody.id === "string") id = terminalBody.id;
        if (typeof terminalBody.model === "string") model = terminalBody.model;
        if (terminalBody.usage !== undefined) usage = terminalBody.usage;
        terminal = true;
      };

      const append = (fragment: string, flush = false): void => {
        if (pendingCarriageReturn) {
          if (fragment.startsWith("\n")) fragment = fragment.slice(1);
          buffer += "\n";
          pendingCarriageReturn = false;
        }
        fragment = fragment.replace(/\r\n/g, "\n");
        if (fragment.endsWith("\r") && !flush) {
          fragment = fragment.slice(0, -1);
          pendingCarriageReturn = true;
        }
        buffer += fragment.replace(/\r/g, "\n");
        if (flush && pendingCarriageReturn) {
          buffer += "\n";
          pendingCarriageReturn = false;
        }
      };

      const drain = (flush: boolean): void => {
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0 && !terminal) {
          const data = sseData(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (data !== null) consume(data);
          boundary = buffer.indexOf("\n\n");
        }
        if (terminal) {
          buffer = "";
          return;
        }
        if (flush && buffer.trim()) {
          const data = sseData(buffer);
          if (data !== null) consume(data);
          buffer = "";
        }
      };

      while (!terminal) {
        const read = awaitWithAbort(reader.read(), abort.signal);
        const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          const timer = setTimeout(() => {
            inactivityTimedOut = true;
            const reason = new Error(`Model API stream was inactive for ${inactivityTimeoutMs}ms`);
            abort.abort(reason);
            reject(reason);
          }, inactivityTimeoutMs);
          read.then(resolve, reject).finally(() => clearTimeout(timer));
        });
        if (chunk.done) {
          append(decoder.decode(), true);
          drain(true);
          break;
        }
        append(decoder.decode(chunk.value, { stream: true }));
        drain(false);
      }
      if (!terminal) {
        throw new ModelApiError(
          "invalid_response",
          "Responses API stream ended before response.completed; partial output was not saved",
          undefined,
          requestId,
          { textCharacters: text.length },
        );
      }
      if (!text) {
        throw new ModelApiError("invalid_response", "Responses API stream does not contain output text", undefined, requestId, terminalBody);
      }
      return { text, id, model, usage, raw: terminalBody ?? { stream: true } };
    } catch (error) {
      if (error instanceof ModelApiError) throw error;
      if (inactivityTimedOut) {
        throw new ModelApiError("timeout", `Model API stream was inactive for ${inactivityTimeoutMs}ms`, undefined, undefined, undefined, { cause: error });
      }
      if (abort.didTimeout()) {
        throw new ModelApiError("timeout", `Model API request timed out after ${timeoutMs}ms`, undefined, undefined, undefined, { cause: error });
      }
      if (requestOptions?.signal?.aborted) {
        throw new ModelApiError("cancelled", "Model API request was cancelled", undefined, undefined, undefined, { cause: error });
      }
      throw new ModelApiError("network", "Model API network request failed", undefined, undefined, undefined, { cause: error });
    } finally {
      if (reader) void reader.cancel().catch(() => undefined);
      abort.cleanup();
    }
  }

  async chatCompletions(request: ChatCompletionsRequest, options?: ModelRequestOptions): Promise<TextModelResult> {
    if (request.stream === true) return this.streamChatCompletions(request, options);
    const body = await this.post("chat/completions", request, options);
    if (!isObject(body)) throw new ModelApiError("invalid_response", "Chat Completions API returned a non-object body");
    throwIfChatOutputWasTruncated(body);
    const text = textFromChat(body);
    if (text === null) {
      throw new ModelApiError(
        "invalid_response",
        "Chat Completions response does not contain assistant text",
        undefined,
        undefined,
        body,
      );
    }
    return {
      text,
      id: typeof body.id === "string" ? body.id : null,
      model: typeof body.model === "string" ? body.model : null,
      usage: body.usage ?? null,
      raw: body,
    };
  }

  private async streamChatCompletions(
    request: ChatCompletionsRequest,
    requestOptions?: ModelRequestOptions,
  ): Promise<TextModelResult> {
    const timeoutMs = requiredTimeout(requestOptions?.timeoutMs ?? this.timeoutMs);
    const inactivityTimeoutMs = requiredTimeout(
      requestOptions?.streamInactivityTimeoutMs ?? this.streamInactivityTimeoutMs,
    );
    const abort = combineAbort(requestOptions?.signal, timeoutMs);
    let inactivityTimedOut = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await awaitWithAbort(
        this.fetcher(endpoint(this.options.baseUrl, "chat/completions"), {
          method: "POST",
          headers: this.headers("text/event-stream"),
          body: JSON.stringify(request),
          signal: abort.signal,
        }),
        abort.signal,
      );
      const requestId = response.headers.get("x-request-id") ?? undefined;
      if (!response.ok || !isEventStream(response) || !response.body) {
        const raw = await awaitWithAbort(response.text(), abort.signal);
        if (!response.ok) {
          const parsed = parseJsonOrRaw(raw);
          throw new ModelApiError(
            errorKindForStatus(response.status),
            providerErrorMessage(parsed, `Model API request failed with HTTP ${response.status}`),
            response.status,
            requestId,
            parsed,
          );
        }
        const parsed = parseJson(raw, response.status, requestId);
        if (!isObject(parsed)) {
          throw new ModelApiError("invalid_response", "Chat Completions API returned a non-object body");
        }
        throwIfChatOutputWasTruncated(parsed, requestId);
        const text = textFromChat(parsed);
        if (text === null) {
          throw new ModelApiError(
            "invalid_response",
            "Chat Completions response does not contain assistant text",
            undefined,
            requestId,
            parsed,
          );
        }
        requestOptions?.onStream?.({
          reasoningCharacters: 0,
          textCharacters: text.length,
          reasoningDelta: "",
          textDelta: text,
        });
        return {
          text,
          id: typeof parsed.id === "string" ? parsed.id : null,
          model: typeof parsed.model === "string" ? parsed.model : null,
          usage: parsed.usage ?? null,
          raw: parsed,
        };
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let pendingCarriageReturn = false;
      let text = "";
      let reasoningCharacters = 0;
      let id: string | null = null;
      let model: string | null = null;
      let usage: unknown = null;
      let finishReason: unknown = null;
      let done = false;

      const consume = (data: string): void => {
        if (!data || data === "[DONE]") {
          if (data === "[DONE]") done = true;
          return;
        }
        const parsed = parseJson(data, response.status, requestId);
        if (!isObject(parsed)) return;
        if (parsed.error !== undefined) {
          throw new ModelApiError("http", providerErrorMessage(parsed, "Model API stream returned an error"), undefined, requestId, parsed);
        }
        if (typeof parsed.id === "string") id = parsed.id;
        if (typeof parsed.model === "string") model = parsed.model;
        if (parsed.usage !== undefined && parsed.usage !== null) usage = parsed.usage;

        const choices = parsed.choices;
        if (!Array.isArray(choices) || !isObject(choices[0])) return;
        if (choices[0].finish_reason !== undefined && choices[0].finish_reason !== null) {
          finishReason = choices[0].finish_reason;
        }
        const delta = isObject(choices[0].delta) ? choices[0].delta : null;
        const message = isObject(choices[0].message) ? choices[0].message : null;
        const reasoningDelta = contentText(delta?.reasoning_content ?? message?.reasoning_content);
        const textDelta = contentText(delta?.content ?? message?.content);
        if (!reasoningDelta && !textDelta) return;
        reasoningCharacters += reasoningDelta.length;
        text += textDelta;
        requestOptions?.onStream?.({
          reasoningCharacters,
          textCharacters: text.length,
          reasoningDelta,
          textDelta,
        });
      };

      const append = (fragment: string, flush = false): void => {
        if (pendingCarriageReturn) {
          if (fragment.startsWith("\n")) fragment = fragment.slice(1);
          buffer += "\n";
          pendingCarriageReturn = false;
        }
        fragment = fragment.replace(/\r\n/g, "\n");
        if (fragment.endsWith("\r") && !flush) {
          fragment = fragment.slice(0, -1);
          pendingCarriageReturn = true;
        }
        buffer += fragment.replace(/\r/g, "\n");
        if (flush && pendingCarriageReturn) {
          buffer += "\n";
          pendingCarriageReturn = false;
        }
      };

      const drain = (flush: boolean): void => {
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0 && !done) {
          const data = sseData(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (data !== null) consume(data);
          boundary = buffer.indexOf("\n\n");
        }
        if (done) {
          buffer = "";
          return;
        }
        if (flush && buffer.trim()) {
          const data = sseData(buffer);
          if (data !== null) consume(data);
          buffer = "";
        }
      };

      while (!done) {
        const read = awaitWithAbort(reader.read(), abort.signal);
        const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          const timer = setTimeout(() => {
            inactivityTimedOut = true;
            const reason = new Error(`Model API stream was inactive for ${inactivityTimeoutMs}ms`);
            abort.abort(reason);
            reject(reason);
          }, inactivityTimeoutMs);
          read.then(resolve, reject).finally(() => clearTimeout(timer));
        });
        if (chunk.done) {
          append(decoder.decode(), true);
          drain(true);
          break;
        }
        append(decoder.decode(chunk.value, { stream: true }));
        drain(false);
      }
      if (!text) {
        throw new ModelApiError(
          "invalid_response",
          "Chat Completions stream does not contain assistant text",
          undefined,
          requestId,
          { reasoningCharacters, finishReason },
        );
      }
      if (finishReason === "length") {
        throw new ModelApiError(
          "invalid_response",
          "Model API output was truncated (finish_reason=length); reduce the requested output or use a model with a larger output limit",
          undefined,
          requestId,
          { finishReason, reasoningCharacters, textCharacters: text.length },
        );
      }
      return {
        text,
        id,
        model,
        usage,
        raw: { stream: true, reasoningCharacters, textCharacters: text.length, finishReason },
      };
    } catch (error) {
      if (error instanceof ModelApiError) throw error;
      if (inactivityTimedOut) {
        throw new ModelApiError(
          "timeout",
          `Model API stream was inactive for ${inactivityTimeoutMs}ms`,
          undefined,
          undefined,
          undefined,
          { cause: error },
        );
      }
      if (abort.didTimeout()) {
        throw new ModelApiError("timeout", `Model API request timed out after ${timeoutMs}ms`, undefined, undefined, undefined, {
          cause: error,
        });
      }
      if (requestOptions?.signal?.aborted) {
        throw new ModelApiError("cancelled", "Model API request was cancelled", undefined, undefined, undefined, {
          cause: error,
        });
      }
      throw new ModelApiError("network", "Model API network request failed", undefined, undefined, undefined, {
        cause: error,
      });
    } finally {
      if (reader) void reader.cancel().catch(() => undefined);
      abort.cleanup();
    }
  }

  async images(request: ImagesRequest, options?: ModelRequestOptions): Promise<ImagesResult> {
    const body = await this.post("images/generations", request, options);
    if (!isObject(body) || !Array.isArray(body.data)) {
      throw new ModelApiError("invalid_response", "Images API response does not contain a data array", undefined, undefined, body);
    }
    const images = body.data.map((item, index): GeneratedImage => {
      if (!isObject(item)) {
        throw new ModelApiError("invalid_response", `Images API item ${index} is invalid`, undefined, undefined, body);
      }
      const url = typeof item.url === "string" ? item.url : null;
      const base64 = typeof item.b64_json === "string" ? item.b64_json : null;
      if (!url && !base64) {
        throw new ModelApiError(
          "invalid_response",
          `Images API item ${index} has neither url nor b64_json`,
          undefined,
          undefined,
          body,
        );
      }
      return {
        url,
        base64,
        revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : null,
      };
    });
    if (images.length === 0) {
      throw new ModelApiError("invalid_response", "Images API returned no images", undefined, undefined, body);
    }
    return { images, raw: body };
  }

  private async post(path: string, body: unknown, requestOptions?: ModelRequestOptions): Promise<unknown> {
    const timeoutMs = requiredTimeout(requestOptions?.timeoutMs ?? this.timeoutMs);
    const abort = combineAbort(requestOptions?.signal, timeoutMs);
    try {
      const response = await awaitWithAbort(
        this.fetcher(endpoint(this.options.baseUrl, path), {
          method: "POST",
          headers: this.headers("application/json"),
          body: JSON.stringify(body),
          signal: abort.signal,
        }),
        abort.signal,
      );
      const raw = await awaitWithAbort(response.text(), abort.signal);
      const parsed = parseJson(raw, response.status, response.headers.get("x-request-id") ?? undefined);
      if (!response.ok) {
        const requestId = response.headers.get("x-request-id") ?? undefined;
        throw new ModelApiError(
          errorKindForStatus(response.status),
          providerErrorMessage(parsed, `Model API request failed with HTTP ${response.status}`),
          response.status,
          requestId,
          parsed,
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof ModelApiError) throw error;
      if (abort.didTimeout()) {
        throw new ModelApiError("timeout", `Model API request timed out after ${timeoutMs}ms`, undefined, undefined, undefined, {
          cause: error,
        });
      }
      if (requestOptions?.signal?.aborted) {
        throw new ModelApiError("cancelled", "Model API request was cancelled", undefined, undefined, undefined, {
          cause: error,
        });
      }
      throw new ModelApiError("network", "Model API network request failed", undefined, undefined, undefined, {
        cause: error,
      });
    } finally {
      abort.cleanup();
    }
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept,
      ...this.options.headers,
    };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    return headers;
  }
}
