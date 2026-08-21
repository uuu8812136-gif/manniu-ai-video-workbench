export type ImageProvider = "openai" | "gemini";

export function imageProviderCompatibilityError(provider: ImageProvider, model: string): string | null {
  if (provider === "gemini" && /^gpt-image(?:-|$)/iu.test(model.trim())) {
    return `模型 ${model.trim()} 需选择 OpenAI Images 协议`;
  }
  return null;
}
