import type { SettingsStorage } from "./secure-settings";
import type { WebhookEvent } from "../shared/contracts";

export type WebhookSendResult = {
  ok: true;
  status: number;
};

function webhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Webhook URL 格式不正确");
  }
  if (
    url.protocol !== "https:"
    || url.hostname.toLowerCase() !== "qyapi.weixin.qq.com"
    || url.pathname !== "/cgi-bin/webhook/send"
    || !url.searchParams.get("key")
    || url.username
    || url.password
    || url.hash
  ) {
    throw new Error("仅支持企业微信机器人 HTTPS Webhook URL");
  }
  return url;
}

function providerError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  if (data.errcode === 0 || data.errcode === "0") return null;
  if (typeof data.errmsg === "string" && data.errmsg.trim()) return data.errmsg.trim().slice(0, 240);
  return data.errcode === undefined ? null : `企业微信返回错误码 ${String(data.errcode).slice(0, 40)}`;
}

export async function sendWecomWebhook(
  urlValue: string,
  content: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<WebhookSendResult> {
  const url = webhookUrl(urlValue);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Webhook 请求超时")), timeoutMs);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: content.slice(0, 2_048) } }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Webhook 发送失败：HTTP ${response.status}`);
    const payload = await response.json().catch(() => null) as unknown;
    const error = providerError(payload);
    if (error) throw new Error(`Webhook 发送失败：${error}`);
    return { ok: true, status: response.status };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Webhook 请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class WebhookNotifier {
  constructor(
    private readonly settings: Pick<SettingsStorage, "get">,
    private readonly sender: typeof sendWecomWebhook = sendWecomWebhook,
  ) {}

  async test(url: string): Promise<WebhookSendResult> {
    return this.sender(url, "【AI工具】测试消息：通知配置成功");
  }

  async notify(event: WebhookEvent, content: string): Promise<boolean> {
    if (this.settings.get("webhook_enabled") !== "true") return false;
    const selected = new Set((this.settings.get("webhook_events") ?? "").split(",").map((value) => value.trim()));
    const url = this.settings.get("webhook_url")?.trim();
    if (!url || !selected.has(event)) return false;
    try {
      await this.sender(url, `【AI工具】${content}`);
      return true;
    } catch {
      return false;
    }
  }
}
