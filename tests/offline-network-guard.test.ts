import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installOfflineNetworkTestGuard, isExternalNetworkUrl } from "../src/main/offline-network-guard";

describe("offline packaged-app network guard", () => {
  const originalFetch = globalThis.fetch;
  const roots: string[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it("classifies public and loopback endpoints", () => {
    expect(isExternalNetworkUrl("https://api.example.test/v1")).toBe(true);
    expect(isExternalNetworkUrl("http://127.0.0.1:11434/v1")).toBe(false);
    expect(isExternalNetworkUrl("http://localhost:8188/v1")).toBe(false);
    expect(isExternalNetworkUrl("file:///app/index.html")).toBe(false);
  });

  it("blocks main and renderer external requests while preserving loopback", async () => {
    const root = mkdtempSync(join(tmpdir(), "AI工具 断网门禁 "));
    roots.push(root);
    const logPath = join(root, "network.jsonl");
    let listener: ((details: { url: string }, callback: (result: { cancel: boolean }) => void) => void) | undefined;
    const fetcher = vi.fn(async () => new Response("local", { status: 200 }));
    const result = installOfflineNetworkTestGuard({
      environment: {
        AI_TOOL_TEST_BLOCK_EXTERNAL_NETWORK: "1",
        AI_TOOL_TEST_NETWORK_LOG: logPath,
      },
      defaultLogPath: logPath,
      fetch: fetcher,
      session: {
        webRequest: {
          onBeforeRequest: vi.fn((_filter, callback) => { listener = callback as typeof listener; }),
        },
      } as never,
    });

    expect(result).toEqual({ active: true, logPath });
    await expect(globalThis.fetch("https://api.example.test/v1")).rejects.toThrow("External network blocked");
    await expect(globalThis.fetch("http://127.0.0.1:11434/v1")).resolves.toBeInstanceOf(Response);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await new Promise<{ cancel: boolean }>((resolve) => listener!({ url: "https://cdn.example.test/a.js" }, resolve))).toEqual({ cancel: true });
    expect(await new Promise<{ cancel: boolean }>((resolve) => listener!({ url: "http://localhost:8188/v1" }, resolve))).toEqual({ cancel: false });
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain('"event":"active"');
    expect(log).toContain('"source":"main-fetch"');
    expect(log).toContain('"source":"renderer"');
  });
});
