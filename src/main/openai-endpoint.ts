export function usesOfficialDeepSeekApi(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl.trim());
    return url.hostname.toLowerCase() === "api.deepseek.com"
      && /^\/(?:v1\/?)?$/u.test(url.pathname);
  } catch {
    return false;
  }
}

const OPENAI_V1_ROOT_HOSTS = new Set(["api.deepseek.com", "yunwu.ai", "www.geeknow.top"]);

export function openAICompatibleEndpoint(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new TypeError("Model API baseUrl is required");
  const root = new URL(`${trimmed.replace(/\/+$/u, "")}/`);
  const hostname = root.hostname.toLowerCase();
  if (OPENAI_V1_ROOT_HOSTS.has(hostname) && root.pathname === "/") {
    root.pathname = "/v1/";
  }
  return new URL(path.replace(/^\/+/, ""), root).toString();
}
