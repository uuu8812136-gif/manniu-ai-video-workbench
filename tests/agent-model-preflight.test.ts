import { describe, expect, it, vi } from "vitest";
import { preflightFileAgentModel } from "../src/main/agent-model-preflight";
import { ModelApiError } from "../src/main/model-clients";

describe("file Agent model preflight", () => {
  it("does not impose a models endpoint on custom OpenAI-compatible gateways", async () => {
    const fetcher = vi.fn();
    await expect(preflightFileAgentModel({
      baseUrl: "http://127.0.0.1:9001/v1",
      apiKey: "local-key",
      model: "local-model",
      fetch: fetcher as unknown as typeof fetch,
    })).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails immediately and redacts a rejected DeepSeek API Key", async () => {
    const error = await preflightFileAgentModel({
      baseUrl: "https://api.deepseek.com",
      apiKey: "must-not-leak",
      model: "deepseek-chat",
      fetch: (async () => new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 })) as typeof fetch,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ModelApiError);
    expect(error).toMatchObject({ kind: "authentication", status: 401, message: expect.stringContaining("鉴权失败") });
    expect(String(error)).not.toContain("must-not-leak");
  });

  it("rejects a configured model that is absent from the authenticated account", async () => {
    const error = await preflightFileAgentModel({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "valid-key",
      model: "deepseek-v4-pro",
      fetch: (async () => new Response(JSON.stringify({
        data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
      }), { status: 200 })) as typeof fetch,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ModelApiError);
    expect(error).toMatchObject({ kind: "configuration", message: expect.stringContaining("deepseek-v4-pro") });
  });

  it("accepts a listed DeepSeek model", async () => {
    await expect(preflightFileAgentModel({
      baseUrl: "https://api.deepseek.com",
      apiKey: "valid-key",
      model: "deepseek-reasoner",
      fetch: (async () => new Response(JSON.stringify({
        data: [{ id: "deepseek-reasoner" }],
      }), { status: 200 })) as typeof fetch,
    })).resolves.toMatchObject({ ok: true, models: ["deepseek-reasoner"] });
  });
});
