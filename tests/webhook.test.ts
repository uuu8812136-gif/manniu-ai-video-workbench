import { describe, expect, it, vi } from "vitest";
import { sendWecomWebhook, WebhookNotifier } from "../src/main/webhook";

describe("WeCom webhook", () => {
  it("sends the expected text payload without exposing the URL in output", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 }));
    await expect(sendWecomWebhook(
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=private-key",
      "测试内容",
      { fetch: fetcher },
    )).resolves.toEqual({ ok: true, status: 200 });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain("key=private-key");
    expect(JSON.parse(String(init?.body))).toEqual({ msgtype: "text", text: { content: "测试内容" } });
  });

  it("rejects non-WeCom and incomplete webhook URLs before networking", async () => {
    const fetcher = vi.fn();
    await expect(sendWecomWebhook("https://example.com/hook?key=x", "test", { fetch: fetcher })).rejects.toThrow("仅支持企业微信");
    await expect(sendWecomWebhook("https://qyapi.weixin.qq.com/cgi-bin/webhook/send", "test", { fetch: fetcher })).rejects.toThrow("仅支持企业微信");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("only sends enabled selected events and swallows automatic delivery failures", async () => {
    const values: Record<string, string> = {
      webhook_enabled: "true",
      webhook_events: "error,batch",
      webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x",
    };
    const sender = vi.fn(async () => ({ ok: true as const, status: 200 }));
    const notifier = new WebhookNotifier({ get: (key) => values[key] ?? null }, sender);
    await expect(notifier.notify("complete", "完成")).resolves.toBe(false);
    await expect(notifier.notify("error", "失败")).resolves.toBe(true);
    expect(sender).toHaveBeenCalledOnce();

    sender.mockRejectedValueOnce(new Error("network"));
    await expect(notifier.notify("batch", "批量完成")).resolves.toBe(false);
  });
});
