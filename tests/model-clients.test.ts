import { describe, expect, it, vi } from "vitest";
import { ModelApiError, OpenAIModelClient } from "../src/main/model-clients";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("OpenAI model client", () => {
  it("calls Responses API and extracts nested output text", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: "resp_1",
        model: "story-model",
        output: [{ content: [{ type: "output_text", text: "第一幕" }, { type: "output_text", text: "完成" }] }],
        usage: { total_tokens: 12 },
      }),
    );
    const client = new OpenAIModelClient({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "local-key",
      fetch: fetcher as unknown as typeof fetch,
    });

    const result = await client.responses({ model: "story-model", input: "开始" });

    expect(result.text).toBe("第一幕完成");
    expect(result.usage).toEqual({ total_tokens: 12 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/v1/responses");
    expect(init).toMatchObject({ method: "POST" });
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer local-key");
  });

  it("rejects an incomplete Responses body even when it contains partial text", async () => {
    const client = new OpenAIModelClient({
      baseUrl: "http://127.0.0.1:11434/v1",
      fetch: (async () => jsonResponse({
        id: "resp_partial",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output_text: "partial",
      })) as typeof fetch,
    });

    const error = await client.responses({ model: "test", input: "x" }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ModelApiError);
    expect(error).toMatchObject({ kind: "invalid_response", message: expect.stringContaining("max_output_tokens") });
  });

  it("streams Responses output and requires a response.completed terminal event", async () => {
    const encoder = new TextEncoder();
    const events = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"完整"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"正文"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream","model":"text-model","status":"completed","output_text":"完整正文","usage":{"total_tokens":8}}}\n\n',
    ].join("");
    const onStream = vi.fn();
    const client = new OpenAIModelClient({
      baseUrl: "http://127.0.0.1:11434/v1",
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(events.slice(0, 73)));
          controller.enqueue(encoder.encode(events.slice(73)));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch,
    });

    const result = await client.responses({ model: "text-model", input: "x", stream: true }, { onStream });

    expect(result).toMatchObject({ text: "完整正文", id: "resp_stream", model: "text-model", usage: { total_tokens: 8 } });
    expect(onStream).toHaveBeenCalledTimes(2);
  });

  it("rejects a Responses stream that closes after partial deltas", async () => {
    const encoder = new TextEncoder();
    const client = new OpenAIModelClient({
      baseUrl: "http://127.0.0.1:11434/v1",
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch,
    });

    const error = await client.responses({ model: "text-model", input: "x", stream: true }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ModelApiError);
    expect(error).toMatchObject({ kind: "invalid_response", message: expect.stringContaining("response.completed") });
  });

  it("supports Chat Completions content arrays and image base64 output", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "chat_1",
          choices: [{ message: { role: "assistant", content: [{ type: "text", text: "分镜" }, { text: "结果" }] } }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ b64_json: "aW1hZ2U=", revised_prompt: "cinematic scene" }] }),
      );
    const client = new OpenAIModelClient({
      baseUrl: "http://localhost:8080/v1/",
      fetch: fetcher as unknown as typeof fetch,
    });

    const chat = await client.chatCompletions({ model: "chat", messages: [{ role: "user", content: "小说" }] });
    const images = await client.images({ model: "image", prompt: "scene" });

    expect(chat.text).toBe("分镜结果");
    expect(images.images).toEqual([{ url: null, base64: "aW1hZ2U=", revisedPrompt: "cinematic scene" }]);
    expect(fetcher.mock.calls[0][0]).toBe("http://localhost:8080/v1/chat/completions");
    expect(fetcher.mock.calls[1][0]).toBe("http://localhost:8080/v1/images/generations");
  });

  it("normalizes the Yunwu root for real image generation requests", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ data: [{ b64_json: "aW1hZ2U=" }] }),
    );
    const client = new OpenAIModelClient({
      baseUrl: "https://yunwu.ai",
      apiKey: "private-key",
      fetch: fetcher as unknown as typeof fetch,
    });

    await client.images({ model: "gpt-image-2", prompt: "scene" });

    expect(fetcher.mock.calls[0][0]).toBe("https://yunwu.ai/v1/images/generations");
  });

  it("consumes fragmented Chat Completions SSE and separates reasoning from final text", async () => {
    const encoder = new TextEncoder();
    const events = [
      'data: {"id":"chat_stream","model":"deepseek-v4-pro","choices":[{"delta":{"reasoning_content":"analysis"}}]}\r\n\r\n',
      'data: {"id":"chat_stream","model":"deepseek-v4-pro","choices":[{"delta":{"content":"story"}}]}\r\n\r\n',
      'data: {"id":"chat_stream","model":"deepseek-v4-pro","choices":[],"usage":{"total_tokens":42}}\r\n\r\n',
      "data: [DONE]\r\n\r\n",
    ].join("");
    const chunks = [events.slice(0, 41), events.slice(41, 137), events.slice(137)];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const onStream = vi.fn();
    const client = new OpenAIModelClient({
      baseUrl: "https://api.deepseek.com",
      apiKey: "secret",
      fetch: fetcher as unknown as typeof fetch,
    });

    const result = await client.chatCompletions(
      { model: "deepseek-v4-pro", messages: [{ role: "user", content: "novel" }], stream: true },
      { onStream },
    );

    expect(result).toMatchObject({ text: "story", id: "chat_stream", model: "deepseek-v4-pro", usage: { total_tokens: 42 } });
    expect(result.raw).toMatchObject({ stream: true, reasoningCharacters: 8, textCharacters: 5 });
    expect(onStream).toHaveBeenNthCalledWith(1, expect.objectContaining({ reasoningDelta: "analysis", textDelta: "" }));
    expect(onStream).toHaveBeenNthCalledWith(2, expect.objectContaining({ reasoningCharacters: 8, textDelta: "story" }));
    expect(fetcher.mock.calls[0][0]).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ stream: true });
  });

  it("rejects a streamed Chat Completions result truncated by the output limit", async () => {
    const encoder = new TextEncoder();
    const events = [
      'data: {"id":"truncated","choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: {"id":"truncated","choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const client = new OpenAIModelClient({
      baseUrl: "https://models.example/v1",
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(events));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch,
    });

    const error = await client.chatCompletions(
      { model: "test", messages: [{ role: "user", content: "x" }], stream: true },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ModelApiError);
    expect(error).toMatchObject({
      kind: "invalid_response",
      message: expect.stringContaining("finish_reason=length"),
      responseBody: { finishReason: "length", reasoningCharacters: 0, textCharacters: 7 },
    });
  });

  it("falls back to a JSON body when a compatible gateway ignores streaming", async () => {
    const client = new OpenAIModelClient({
      baseUrl: "http://localhost:11434/v1",
      fetch: (async () => jsonResponse({
        id: "json-fallback",
        model: "local-chat",
        choices: [{ message: { role: "assistant", content: "complete result" } }],
      })) as typeof fetch,
    });
    const onStream = vi.fn();

    const result = await client.chatCompletions(
      { model: "local-chat", messages: [{ role: "user", content: "x" }], stream: true },
      { onStream },
    );

    expect(result.text).toBe("complete result");
    expect(onStream).toHaveBeenCalledWith(expect.objectContaining({ textDelta: "complete result" }));
  });

  it("supports lone carriage-return SSE delimiters and ignores events after DONE", async () => {
    const encoder = new TextEncoder();
    const payload = [
      'data: {"choices":[{"delta":{"content":"kept"}}]}\r\r',
      "data: [DONE]\r\r",
      'data: {"choices":[{"delta":{"content":"ignored"}}]}\r\r',
    ].join("");
    const client = new OpenAIModelClient({
      baseUrl: "https://models.example/v1",
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(payload.slice(0, 53)));
          controller.enqueue(encoder.encode(payload.slice(53)));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch,
    });

    const result = await client.chatCompletions(
      { model: "test", messages: [{ role: "user", content: "x" }], stream: true },
    );

    expect(result.text).toBe("kept");
  });

  it.each([
    [401, "authentication"],
    [429, "rate_limit"],
    [502, "server"],
  ] as const)("classifies non-JSON streaming HTTP %i responses as %s", async (status, kind) => {
    const client = new OpenAIModelClient({
      baseUrl: "https://models.example/v1",
      fetch: (async () => new Response("upstream unavailable", {
        status,
        headers: { "content-type": "text/plain", "x-request-id": "req-stream" },
      })) as typeof fetch,
    });

    const error = await client.chatCompletions(
      { model: "test", messages: [{ role: "user", content: "x" }], stream: true },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ModelApiError);
    expect(error).toMatchObject({ kind, status, requestId: "req-stream", responseBody: "upstream unavailable" });
  });

  it("times out an inactive stream and honours caller cancellation while reading", async () => {
    const neverEndingResponse = (): Response => new Response(new ReadableStream<Uint8Array>({
      start() {
        // Intentionally idle.
      },
    }), { headers: { "content-type": "text/event-stream" } });
    const client = new OpenAIModelClient({
      baseUrl: "https://models.example/v1",
      timeoutMs: 1_000,
      streamInactivityTimeoutMs: 20,
      fetch: (async () => neverEndingResponse()) as typeof fetch,
    });

    const inactive = await client.chatCompletions(
      { model: "test", messages: [{ role: "user", content: "x" }], stream: true },
    ).catch((reason: unknown) => reason);
    expect(inactive).toBeInstanceOf(ModelApiError);
    expect(inactive).toMatchObject({ kind: "timeout", message: "Model API stream was inactive for 20ms" });

    const controller = new AbortController();
    const pending = client.chatCompletions(
      { model: "test", messages: [{ role: "user", content: "x" }], stream: true },
      { signal: controller.signal, streamInactivityTimeoutMs: 1_000 },
    );
    controller.abort(new Error("stop"));
    const cancelled = await pending.catch((reason: unknown) => reason);
    expect(cancelled).toBeInstanceOf(ModelApiError);
    expect(cancelled).toMatchObject({ kind: "cancelled" });
  });

  it("classifies provider status and preserves request diagnostics", async () => {
    const client = new OpenAIModelClient({
      baseUrl: "https://models.example/v1",
      fetch: (async () =>
        jsonResponse(
          { error: { message: "API key rejected" } },
          { status: 401, headers: { "x-request-id": "req_123" } },
        )) as typeof fetch,
    });

    const error = await client.responses({ model: "test", input: "x" }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ModelApiError);
    expect(error).toMatchObject({
      kind: "authentication",
      status: 401,
      requestId: "req_123",
      message: "API key rejected",
    });
  });

  it("classifies malformed successful responses", async () => {
    const client = new OpenAIModelClient({
      baseUrl: "https://models.example/v1",
      fetch: (async () => new Response("not-json", { status: 200 })) as typeof fetch,
    });

    const error = await client.images({ prompt: "x" }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ModelApiError);
    expect(error).toMatchObject({ kind: "invalid_response", status: 200, responseBody: "not-json" });
  });

  it("enforces timeout and distinguishes caller cancellation", async () => {
    // The client timeout must settle even if an injected transport ignores AbortSignal.
    const fetcher = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const client = new OpenAIModelClient({ baseUrl: "https://models.example/v1", timeoutMs: 20, fetch: fetcher });

    const timeout = await client.responses({ model: "test", input: "x" }).catch((reason: unknown) => reason);
    expect(timeout).toBeInstanceOf(ModelApiError);
    expect(timeout).toMatchObject({ kind: "timeout" });

    const controller = new AbortController();
    const pending = client.chatCompletions(
      { model: "test", messages: [{ role: "user", content: "x" }] },
      { signal: controller.signal, timeoutMs: 1_000 },
    );
    controller.abort(new Error("user stopped"));
    const cancelled = await pending.catch((reason: unknown) => reason);
    expect(cancelled).toBeInstanceOf(ModelApiError);
    expect(cancelled).toMatchObject({ kind: "cancelled" });
  });

  it("classifies transport errors without leaking credentials", async () => {
    const client = new OpenAIModelClient({
      baseUrl: "https://models.example/v1",
      apiKey: "do-not-leak",
      fetch: (async () => {
        throw new TypeError("connection refused");
      }) as typeof fetch,
    });

    const error = await client.responses({ model: "test", input: "x" }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ModelApiError);
    expect(error).toMatchObject({ kind: "network", message: "Model API network request failed" });
    expect(String(error)).not.toContain("do-not-leak");
  });
});
