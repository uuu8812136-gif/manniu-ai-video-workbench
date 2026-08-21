import { describe, expect, it, vi } from "vitest";
import { GeminiImageClient } from "../src/main/gemini-client";

describe("Gemini image client", () => {
  it("calls generateContent and extracts inline image data", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "done" }, { inlineData: { mimeType: "image/png", data: "aW1n" } }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new GeminiImageClient({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gemini-key",
      fetch: fetcher as unknown as typeof fetch,
    });

    const result = await client.images({ model: "gemini-2.5-flash-image", prompt: "夜色车站", aspectRatio: "16:9" });

    expect(result.images).toEqual([
      { url: null, base64: "aW1n", revisedPrompt: null, mimeType: "image/png" },
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("gemini-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9" } },
    });
  });

  it("includes selected reference images as inline Gemini parts", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "out" } }] } }] }), { status: 200 }),
    );
    const client = new GeminiImageClient({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "key",
      fetch: fetcher as unknown as typeof fetch,
    });

    await client.images({
      model: "gemini-image",
      prompt: "保持人物一致",
      referenceImages: [{ mimeType: "image/jpeg", base64: "cmVm" }],
    });

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      contents: [{ parts: [{ text: "保持人物一致" }, { inlineData: { mimeType: "image/jpeg", data: "cmVm" } }] }],
    });
  });
});
