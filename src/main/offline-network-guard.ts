import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Session } from "electron";

export const OFFLINE_NETWORK_GUARD_ENV = "AI_TOOL_TEST_BLOCK_EXTERNAL_NETWORK";
export const OFFLINE_NETWORK_LOG_ENV = "AI_TOOL_TEST_NETWORK_LOG";

type GuardAttempt = {
  source: "main-fetch" | "renderer";
  url: string;
  at: string;
};

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value.endsWith(".localhost") || value === "::1" || /^127(?:\.\d{1,3}){3}$/.test(value);
}

export function isExternalNetworkUrl(value: string | URL): boolean {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return false;
  }
  return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !isLoopbackHost(url.hostname);
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function installOfflineNetworkTestGuard(options: {
  session: Pick<Session, "webRequest">;
  environment?: NodeJS.ProcessEnv;
  defaultLogPath: string;
  fetch?: typeof fetch;
}): { active: boolean; logPath: string | null } {
  const environment = options.environment ?? process.env;
  if (environment[OFFLINE_NETWORK_GUARD_ENV] !== "1") return { active: false, logPath: null };

  const logPath = environment[OFFLINE_NETWORK_LOG_ENV]?.trim() || options.defaultLogPath;
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, `${JSON.stringify({ event: "active", at: new Date().toISOString() })}\n`, "utf8");
  const record = (attempt: GuardAttempt): void => {
    appendFileSync(logPath, `${JSON.stringify({ event: "blocked", ...attempt })}\n`, "utf8");
  };

  const originalFetch = options.fetch ?? globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = requestUrl(input);
    if (isExternalNetworkUrl(url)) {
      record({ source: "main-fetch", url, at: new Date().toISOString() });
      return Promise.reject(new TypeError(`External network blocked by offline test guard: ${url}`));
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  options.session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => {
      const cancel = isExternalNetworkUrl(details.url);
      if (cancel) record({ source: "renderer", url: details.url, at: new Date().toISOString() });
      callback({ cancel });
    },
  );
  return { active: true, logPath };
}
