import { describe, expect, it, vi } from "vitest";
import { probeModelConnection } from "../src/main/model-probe";

describe("model connection probe", () => {
  it("checks an OpenAI-compatible models endpoint without leaking credentials", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), { status: 200 }),
    );
    const result = await probeModelConnection({
      provider: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "private-key",
      fetch: fetcher as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ok: true, provider: "openai", status: 200, models: ["model-a", "model-b"] });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/v1/models");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer private-key");
    expect(JSON.stringify(result)).not.toContain("private-key");
  });

  it("checks a configured Gemini model with x-goog-api-key", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ name: "models/gemini-image" }), { status: 200 }),
    );
    const result = await probeModelConnection({
      provider: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gemini-key",
      model: "gemini-image",
      fetch: fetcher as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-image");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("gemini-key");
  });

  it("normalizes the official DeepSeek root to its v1 models endpoint", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }] }), { status: 200 }),
    );
    await probeModelConnection({
      provider: "openai",
      baseUrl: "https://api.deepseek.com",
      apiKey: "private-key",
      fetch: fetcher as unknown as typeof fetch,
    });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.deepseek.com/v1/models");
  });

  it("normalizes the Yunwu root to its v1 models endpoint", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ id: "gpt-image-2" }] }), { status: 200 }),
    );
    const result = await probeModelConnection({
      provider: "openai",
      baseUrl: "https://yunwu.ai",
      apiKey: "private-key",
      model: "gpt-image-2",
      fetch: fetcher as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ok: true, models: ["gpt-image-2"] });
    expect(fetcher.mock.calls[0][0]).toBe("https://yunwu.ai/v1/models");
  });

  it("normalizes the Geeknow root to its v1 models endpoint", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ id: "gpt-image-2" }] }), { status: 200 }),
    );
    await probeModelConnection({
      provider: "openai",
      baseUrl: "https://www.geeknow.top/",
      fetch: fetcher as unknown as typeof fetch,
    });

    expect(fetcher.mock.calls[0][0]).toBe("https://www.geeknow.top/v1/models");
  });

  it("rejects an OpenAI image model configured with the Gemini protocol before sending a request", async () => {
    const fetcher = vi.fn();
    const result = await probeModelConnection({
      provider: "gemini",
      baseUrl: "https://yunwu.ai",
      apiKey: "private-key",
      model: "gpt-image-2",
      fetch: fetcher as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      ok: false,
      provider: "gemini",
      status: null,
      message: "模型 gpt-image-2 需选择 OpenAI Images 协议",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("explains a successful HTML response as an API address or protocol mismatch", async () => {
    const result = await probeModelConnection({
      provider: "openai",
      baseUrl: "https://models.example",
      fetch: (async () => new Response("<!doctype html><title>Home</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 200,
      message: "接口返回网页而非 JSON，请检查 API 地址是否需要 /v1，并确认服务协议",
    });
  });

  it("keeps non-HTML gateway text errors distinct from a webpage response", async () => {
    const result = await probeModelConnection({
      provider: "openai",
      baseUrl: "https://models.example/v1",
      fetch: (async () => new Response("Bad Gateway", {
        status: 502,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch,
    });

    expect(result).toMatchObject({ ok: false, status: 502, message: "接口未返回有效 JSON" });
  });

  it("returns a classified public failure without response secrets", async () => {
    const result = await probeModelConnection({
      provider: "openai",
      baseUrl: "https://models.example/v1",
      fetch: (async () => new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 })) as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, status: 401, message: "unauthorized" });
  });
});
