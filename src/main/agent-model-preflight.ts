import { ModelApiError, type ModelErrorKind } from "./model-clients";
import { probeModelConnection, type ModelProbeResult } from "./model-probe";
import { usesOfficialDeepSeekApi } from "./openai-endpoint";

type FileAgentModelPreflightInput = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
};

function errorKind(status: number | null): ModelErrorKind {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limit";
  if (status !== null && status >= 500) return "server";
  return status === null ? "network" : "http";
}

function unavailableMessage(result: ModelProbeResult): string {
  if (result.status === 401 || result.status === 403) {
    return `DeepSeek API Key 鉴权失败（HTTP ${result.status}）。请在设置中更新小说转分镜 API Key，并先执行“测试连接”。`;
  }
  return `DeepSeek 模型预检失败${result.status === null ? "" : `（HTTP ${result.status}）`}：${result.message}`;
}

export async function preflightFileAgentModel(input: FileAgentModelPreflightInput): Promise<ModelProbeResult | null> {
  if (!usesOfficialDeepSeekApi(input.baseUrl)) return null;
  const result = await probeModelConnection({
    provider: "openai",
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    model: input.model,
    timeoutMs: 15_000,
    fetch: input.fetch,
  });
  if (!result.ok) {
    throw new ModelApiError(errorKind(result.status), unavailableMessage(result), result.status ?? undefined);
  }
  if (result.models.length > 0 && !result.models.includes(input.model)) {
    throw new ModelApiError(
      "configuration",
      `DeepSeek 模型“${input.model}”不在当前账号的可用列表中：${result.models.join("、")}`,
    );
  }
  return result;
}
