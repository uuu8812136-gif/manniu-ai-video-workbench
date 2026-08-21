import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViduAccount } from "../src/shared/contracts";

type FakeWindow = ReturnType<typeof fakeWindow>;

const electronMock = vi.hoisted(() => ({
  windows: [] as unknown[],
  options: [] as unknown[],
  browserSession: null as null | {
    fetch: ReturnType<typeof vi.fn>;
    clearStorageData: ReturnType<typeof vi.fn>;
    clearCache: ReturnType<typeof vi.fn>;
    cookies: { set: ReturnType<typeof vi.fn>; flushStore: ReturnType<typeof vi.fn> };
  },
  createFromBuffer: vi.fn(() => ({ isEmpty: (): boolean => false, getSize: () => ({ width: 800, height: 1200 }) })),
}));

vi.mock("electron", () => ({
  BrowserWindow: class {
    constructor(options: unknown) {
      electronMock.options.push(options);
      const window = electronMock.windows.shift();
      if (!window) throw new Error("No fake BrowserWindow queued");
      return window;
    }
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) })),
    createFromBuffer: electronMock.createFromBuffer,
  },
  session: {
    fromPartition: vi.fn(() => electronMock.browserSession ?? ({
      fetch: vi.fn(),
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      cookies: { set: vi.fn(async () => undefined), flushStore: vi.fn(async () => undefined) },
    })),
  },
  shell: { openExternal: vi.fn(async () => undefined) },
}));

import {
  ViduBrowserClient,
  ViduBrowserManager,
  chooseViduReplacementCandidate,
  extractAvailableViduCredits,
  fingerprintViduAsset,
  isViduQuotaFailure,
  isViduPlanLimitFailure,
  isViduSubjectLimitFailure,
  parseViduSubjectClipboard,
  viduMaterialRetryDelay,
  viduSubjectPreparationGapMs,
} from "../src/main/vidu-browser";
import { VideoApiError } from "../src/main/video-client";

const account: ViduAccount = {
  id: "account-1",
  name: "测试账号",
  sessionKey: "12345678-1234-1234-1234-123456789abc",
  jwtFingerprint: null,
  enabled: true,
  accountType: "member",
  defaultQuota: 200,
  usageCount: 0,
  usageDate: "",
  sortOrder: 0,
  disabledReason: null,
  disabledMessage: null,
  disabledAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function fakeWindow(options: {
  load?: () => Promise<void>;
  execute?: (script: string) => Promise<unknown>;
} = {}) {
  let destroyed = false;
  let visible = false;
  const handlers = new Map<string, () => void>();
  const window = {
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      executeJavaScript: vi.fn((script: string) => options.execute?.(script) ?? Promise.resolve({ status: 200, body: "{}" })),
    },
    loadURL: vi.fn(() => options.load?.() ?? Promise.resolve()),
    on: vi.fn((event: string, handler: () => void) => { handlers.set(event, handler); }),
    show: vi.fn(() => { visible = true; }),
    focus: vi.fn(),
    isVisible: vi.fn(() => visible),
    isDestroyed: vi.fn(() => destroyed),
    destroy: vi.fn(() => {
      if (destroyed) return;
      destroyed = true;
      handlers.get("closed")?.();
    }),
  };
  return window;
}

function submitRequest(prompt: string) {
  return {
    projectId: 1,
    prompt,
    durationSeconds: 4,
    model: "Q3" as const,
    useCredits: false,
    projectDirectory: "C:\\project",
  };
}

function futureJwt(): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ exp: Math.floor(Date.now() / 1_000) + 3_600, sub: "vidu-user" })}.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG`;
}

function browserSession(fetcher: typeof fetch = (async () => new Response('{"tasks":[]}')) as typeof fetch) {
  return {
    fetch: vi.fn(fetcher),
    clearStorageData: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    cookies: { set: vi.fn(async () => undefined), flushStore: vi.fn(async () => undefined) },
  };
}

describe("Vidu browser request sequencing", () => {
  let temporaryDirectories: string[] = [];

  beforeEach(() => {
    electronMock.windows.length = 0;
    electronMock.options.length = 0;
    electronMock.browserSession = browserSession();
    electronMock.createFromBuffer.mockReset().mockImplementation(() => ({ isEmpty: (): boolean => false, getSize: () => ({ width: 800, height: 1200 }) }));
    temporaryDirectories = [];
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
  });
  it("matches the original subject preparation pacing", () => {
    expect(Array.from({ length: 7 }, (_, index) => viduSubjectPreparationGapMs(index + 1, 7)))
      .toEqual([3_000, 3_000, 10_000, 3_000, 3_000, 10_000, 0]);
    expect(viduSubjectPreparationGapMs(1, 1)).toBe(0);
  });
  it("classifies original and localized subject-library limit responses", () => {
    expect(isViduSubjectLimitFailure("ACCOUNT_SUBJECT_LIMITED: too many operations")).toBe(true);
    expect(isViduSubjectLimitFailure('{"reason":"ElementOperateLimitExceeded"}')).toBe(true);
    expect(isViduSubjectLimitFailure('{"code":"MonthLimit"}')).toBe(true);
    expect(isViduSubjectLimitFailure('{"reason":"FreeMonth"}')).toBe(true);
    expect(isViduSubjectLimitFailure('{"message":"主体库操作频率超限"}')).toBe(true);
    expect(isViduSubjectLimitFailure('{"message":"积分不足"}')).toBe(false);
  });

  it("classifies every compact quota reason used by the original runtime", () => {
    for (const reason of [
      "CreditNotEnough",
      "CreditsNotEnough",
      "CreditNotAvailable",
      "CreditsNotAvailable",
      "NotEnoughCredit",
      "NotEnoughCredits",
      "InsufficientCredit",
      "InsufficientCredits",
      "InsufficientBalance",
      "BalanceInsufficient",
      "CreditBalanceInsufficient",
      "QuotaExceeded",
      "QuotaExhausted",
    ]) expect(isViduQuotaFailure(JSON.stringify({ reason }))).toBe(true);
    expect(isViduQuotaFailure('{"reason":"NonPeakTaskSubmitLimitExceeded"}')).toBe(false);
    expect(isViduQuotaFailure('{"reason":"SubPlanNotSupportedForTask"}')).toBe(false);
    expect(isViduPlanLimitFailure('{"reason":"NonPeakTaskSubmitLimitExceeded"}')).toBe(true);
    expect(isViduPlanLimitFailure('{"reason":"SubPlanNotSupportedForTask"}')).toBe(true);
    expect(isViduQuotaFailure('{"reason":"TooManyRequests"}')).toBe(false);
  });

  it("serializes before-history through POST and fallback diff for one account", async () => {
    const order: string[] = [];
    const visibleTaskIds: string[] = [];
    let postCount = 0;
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes("pager.pagesz=1")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes("pager.pagesz=100")) return { status: 200, body: JSON.stringify({ tasks: [], pager: {} }) };
        if (script.includes("pager.pagesz=5")) {
          order.push("history");
          return { status: 200, body: JSON.stringify({ tasks: visibleTaskIds.map((id) => ({ id })) }) };
        }
        if (script.includes("https://service.vidu.cn/vidu/v1/tasks") && script.includes('"method":"POST"')) {
          order.push("post");
          postCount += 1;
          visibleTaskIds.unshift(`task-${postCount}`);
          return {
            status: 200,
            body: JSON.stringify({ data: { creations: [{ id: `creation-${postCount}` }] } }),
          };
        }
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    const [first, second] = await Promise.all([
      client.submit(submitRequest("first")),
      client.submit(submitRequest("second")),
    ]);

    expect(first.taskId).toBe("task-1");
    expect(second.taskId).toBe("task-2");
    expect(order).toEqual(["history", "post", "history", "history", "post", "history"]);
    client.dispose();
  });

  it("serializes subject preparation through POST across client instances for one account", async () => {
    const order: string[] = [];
    let releaseFirstPreparation!: () => void;
    const firstPreparation = new Promise<void>((resolve) => { releaseFirstPreparation = resolve; });
    let posts = 0;
    const execute = async (script: string) => {
      if (script.includes("pager.pagesz=1") || script.includes("pager.pagesz=100") || script.includes("pager.pagesz=5")) {
        if (script.includes("pager.pagesz=5")) order.push("history");
        return { status: 200, body: JSON.stringify({ tasks: [], pager: {} }) };
      }
      if (script.includes('"method":"POST"')) {
        posts += 1;
        order.push(`post-${posts}`);
        return { status: 200, body: JSON.stringify({ task_id: `task-${posts}` }) };
      }
      throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
    };
    electronMock.windows.push(fakeWindow({ execute }), fakeWindow({ execute }));
    const firstClient = new ViduBrowserClient(account);
    const secondClient = new ViduBrowserClient(account);
    Object.assign(firstClient, {
      prepareMaterials: vi.fn(async () => {
        order.push("prepare-first");
        await firstPreparation;
        return [];
      }),
    });
    const secondPreparation = vi.fn(async () => {
      order.push("prepare-second");
      return [];
    });
    Object.assign(secondClient, { prepareMaterials: secondPreparation });

    const first = firstClient.submit(submitRequest("first"));
    await vi.waitFor(() => expect(order).toEqual(["prepare-first"]));
    const second = secondClient.submit(submitRequest("second"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondPreparation).not.toHaveBeenCalled();
    releaseFirstPreparation();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ taskId: "task-1" }),
      expect.objectContaining({ taskId: "task-2" }),
    ]);
    expect(order).toEqual(["prepare-first", "history", "post-1", "prepare-second", "history", "post-2"]);
    firstClient.dispose();
    secondClient.dispose();
  });

  it("releases the account submission lock after a queued request is cancelled", async () => {
    let releaseFirstPost!: () => void;
    let notifyFirstPost!: () => void;
    const firstPost = new Promise<void>((resolve) => { notifyFirstPost = resolve; });
    const firstPostGate = new Promise<void>((resolve) => { releaseFirstPost = resolve; });
    let posts = 0;
    const execute = async (script: string) => {
      if (script.includes("pager.pagesz=1") || script.includes("pager.pagesz=100") || script.includes("pager.pagesz=5")) {
        return { status: 200, body: JSON.stringify({ tasks: [], pager: {} }) };
      }
      if (script.includes('"method":"POST"')) {
        posts += 1;
        if (posts === 1) {
          notifyFirstPost();
          await firstPostGate;
        }
        return { status: 200, body: JSON.stringify({ task_id: `task-${posts}` }) };
      }
      throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
    };
    electronMock.windows.push(fakeWindow({ execute }), fakeWindow({ execute }));
    const firstClient = new ViduBrowserClient(account);
    const cancelledClient = new ViduBrowserClient(account);
    const thirdClient = new ViduBrowserClient(account);
    const controller = new AbortController();

    const first = firstClient.submit(submitRequest("first"));
    await firstPost;
    const cancelled = cancelledClient.submit(submitRequest("cancelled"), { signal: controller.signal });
    const third = thirdClient.submit(submitRequest("third"));
    controller.abort(new Error("cancel queued submit"));
    releaseFirstPost();

    await expect(first).resolves.toMatchObject({ taskId: "task-1" });
    await expect(cancelled).rejects.toMatchObject({ kind: "cancelled" });
    await expect(third).resolves.toMatchObject({ taskId: "task-2" });
    expect(posts).toBe(2);
    firstClient.dispose();
    cancelledClient.dispose();
    thirdClient.dispose();
  });

  it("releases the account submission lock after an exception", async () => {
    let posts = 0;
    const execute = async (script: string) => {
      if (script.includes("pager.pagesz=1") || script.includes("pager.pagesz=100") || script.includes("pager.pagesz=5")) {
        return { status: 200, body: JSON.stringify({ tasks: [], pager: {} }) };
      }
      if (script.includes('"method":"POST"')) {
        posts += 1;
        return posts === 1
          ? { status: 500, body: "temporary submit failure" }
          : { status: 200, body: JSON.stringify({ task_id: "task-after-error" }) };
      }
      throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
    };
    electronMock.windows.push(fakeWindow({ execute }), fakeWindow({ execute }));
    const firstClient = new ViduBrowserClient(account);
    const secondClient = new ViduBrowserClient(account);

    const first = firstClient.submit(submitRequest("first"));
    const second = secondClient.submit(submitRequest("second"));

    await expect(first).rejects.toMatchObject({ kind: "invalid_response", status: 500 });
    await expect(second).resolves.toMatchObject({ taskId: "task-after-error" });
    expect(posts).toBe(2);
    firstClient.dispose();
    secondClient.dispose();
  });

  it("destroys and resets a failed load so a later login can retry", async () => {
    const first = fakeWindow({ load: async () => { throw new Error("load failed"); } });
    const second = fakeWindow();
    electronMock.windows.push(first, second);
    const client = new ViduBrowserClient(account);

    await expect(client.openLogin()).rejects.toThrow("load failed");
    expect(first.destroy).toHaveBeenCalledOnce();

    await expect(client.openLogin()).resolves.toBeUndefined();
    expect(second.loadURL).toHaveBeenCalledOnce();
    expect(second.show).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("keeps website child windows hidden until login is opened manually", async () => {
    const window = fakeWindow();
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);
    const internal = client as unknown as { ensureWindow(show: boolean): Promise<unknown> };

    await internal.ensureWindow(false);
    const handler = window.webContents.setWindowOpenHandler.mock.calls[0][0] as (details: { url: string }) => {
      action: string;
      overrideBrowserWindowOptions: { show: boolean };
    };
    expect(handler({ url: "https://www.vidu.cn/login" }).overrideBrowserWindowOptions.show).toBe(false);
    expect(window.show).not.toHaveBeenCalled();

    await client.openLogin();
    expect(handler({ url: "https://www.vidu.cn/login" }).overrideBrowserWindowOptions.show).toBe(true);
    expect(window.show).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("uses history instead of trusting an ambiguous top-level response id", async () => {
    let historyReads = 0;
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes("pager.pagesz=1")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes("pager.pagesz=100")) return { status: 200, body: JSON.stringify({ tasks: [], pager: {} }) };
        if (script.includes("pager.pagesz=5")) {
          historyReads += 1;
          return { status: 200, body: JSON.stringify({ tasks: historyReads === 1 ? [] : [{ id: "task-confirmed" }] }) };
        }
        if (script.includes('"method":"POST"')) {
          return { status: 200, body: JSON.stringify({ id: "request-id" }) };
        }
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    await expect(client.submit(submitRequest("scene"))).resolves.toMatchObject({ taskId: "task-confirmed" });
    client.dispose();
  });

  it.each(["top-level", "nested-pager"] as const)("follows a %s next-page token when counting in-progress tasks", async (tokenShape) => {
    let firstPageReads = 0;
    let secondPageReads = 0;
    let posts = 0;
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes("pager.pagesz=100") && script.includes("pager.page_token=second-page")) {
          secondPageReads += 1;
          return {
            status: 200,
            body: JSON.stringify({
              tasks: Array.from({ length: 40 }, (_, id) => ({ id: `second-${id}`, state: "processing" })),
            }),
          };
        }
        if (script.includes("pager.pagesz=100")) {
          firstPageReads += 1;
          const firstPageCount = firstPageReads === 1 ? 60 : 59;
          const pagination = tokenShape === "top-level"
            ? { next_page_token: "second-page" }
            : { pager: { next_page_token: "second-page" } };
          return {
            status: 200,
            body: JSON.stringify({
              tasks: Array.from({ length: firstPageCount }, (_, id) => ({ id: `first-${id}`, state: "processing" })),
              ...pagination,
            }),
          };
        }
        if (script.includes("pager.pagesz=1")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes("pager.pagesz=5")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes('"method":"POST"')) {
          posts += 1;
          return { status: 200, body: JSON.stringify({ task_id: "task-after-pages" }) };
        }
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    await expect(client.submit(submitRequest("scene"), { throttleProbeMs: 1 })).resolves.toMatchObject({
      taskId: "task-after-pages",
    });
    expect(firstPageReads).toBe(2);
    expect(secondPageReads).toBe(2);
    expect(posts).toBe(1);
    client.dispose();
  });

  it("waits for the in-progress count to fall below 100 before submitting", async () => {
    let probes = 0;
    let posts = 0;
    const throttled = vi.fn();
    const recovered = vi.fn();
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes("pager.pagesz=100")) {
          probes += 1;
          const count = probes === 1 ? 100 : 99;
          return { status: 200, body: JSON.stringify({ tasks: Array.from({ length: count }, (_, id) => ({ id, state: "processing" })), pager: {} }) };
        }
        if (script.includes("pager.pagesz=1")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes("pager.pagesz=5")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes('"method":"POST"')) {
          posts += 1;
          return { status: 200, body: JSON.stringify({ task_id: "task-after-capacity" }) };
        }
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    await expect(client.submit(submitRequest("scene"), {
      throttleProbeMs: 1,
      onThrottled: throttled,
      onThrottleRecovered: recovered,
    })).resolves.toMatchObject({ taskId: "task-after-capacity" });
    expect(probes).toBe(2);
    expect(posts).toBe(1);
    expect(throttled).toHaveBeenCalledWith({ reason: "in_progress", inProgress: 100, retryInMs: 1 });
    expect(recovered).toHaveBeenCalledWith({ inProgress: 99 });
    client.dispose();
  });

  it.each([
    { status: 0, body: "timeout" },
    { status: 503, body: "temporarily unavailable" },
  ])("stops before POST when the concurrency count endpoint returns $status", async ({ status, body }) => {
    let posts = 0;
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes("pager.pagesz=100")) return { status, body };
        if (script.includes("pager.pagesz=1")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes("pager.pagesz=5")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes('"method":"POST"')) {
          posts += 1;
          return { status: 200, body: JSON.stringify({ task_id: "task-after-count-failure" }) };
        }
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    await expect(client.submit(submitRequest("scene"))).rejects.toMatchObject({ kind: "unavailable", status });
    expect(posts).toBe(0);
    client.dispose();
  });

  it("treats an ordinary 429 as a recoverable throttle and retries after probing", async () => {
    let probes = 0;
    let posts = 0;
    const throttled = vi.fn();
    const recovered = vi.fn();
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes("pager.pagesz=100")) {
          probes += 1;
          return { status: 200, body: JSON.stringify({ tasks: [], pager: {} }) };
        }
        if (script.includes("pager.pagesz=1")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes("pager.pagesz=5")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes('"method":"POST"')) {
          posts += 1;
          return posts === 1
            ? { status: 429, body: JSON.stringify({ message: "too many requests" }) }
            : { status: 200, body: JSON.stringify({ task_id: "task-after-429" }) };
        }
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    await expect(client.submit(submitRequest("scene"), {
      throttleProbeMs: 1,
      onThrottled: throttled,
      onThrottleRecovered: recovered,
    })).resolves.toMatchObject({ taskId: "task-after-429" });
    expect(probes).toBe(2);
    expect(posts).toBe(2);
    expect(throttled).toHaveBeenCalledWith({ reason: "rate_limit", inProgress: null, retryInMs: 1 });
    expect(recovered).toHaveBeenCalledWith({ inProgress: 0 });
    client.dispose();
  });

  it("matches the original 403 classification for submit and task lookup", async () => {
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes("pager.pagesz=1")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes("pager.pagesz=100")) return { status: 200, body: JSON.stringify({ tasks: [], pager: {} }) };
        if (script.includes("pager.pagesz=5")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes('"method":"POST"')) return { status: 403, body: JSON.stringify({ message: "forbidden" }) };
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
      },
    });
    electronMock.windows.push(window);
    const submitting = new ViduBrowserClient(account);
    await expect(submitting.submit(submitRequest("scene"))).rejects.toMatchObject({ kind: "http", status: 403 });
    submitting.dispose();

    electronMock.browserSession = browserSession(async (input) => {
      const url = String(input);
      if (url.includes("/tasks/task-from-history")) return new Response("{}", { status: 403 });
      if (url.includes("tasks/history/me")) {
        return new Response(JSON.stringify({
          tasks: [{
            id: "task-from-history",
            state: "success",
            creations: [{ download_uri: "https://mock/video.mp4" }],
          }],
        }));
      }
      throw new Error(`Unexpected Vidu request: ${url}`);
    });
    const recovering = new ViduBrowserClient(account);
    await expect(recovering.poll("task-from-history")).resolves.toMatchObject({
      taskId: "task-from-history",
      phase: "succeeded",
      resultUrl: "https://mock/video.mp4",
    });
    recovering.dispose();
  });

  it("lets the submit endpoint decide when the credit preflight returns 403", async () => {
    let posts = 0;
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes("pager.pagesz=1")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes("/credit/v1/credits/me")) return { status: 403, body: JSON.stringify({ message: "credit probe forbidden" }) };
        if (script.includes("pager.pagesz=100")) return { status: 200, body: JSON.stringify({ tasks: [], pager: {} }) };
        if (script.includes("pager.pagesz=5")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes('"method":"POST"')) {
          posts += 1;
          return { status: 200, body: JSON.stringify({ task_id: "task-after-credit-403" }) };
        }
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);
    await expect(client.submit({ ...submitRequest("scene"), useCredits: true })).resolves.toMatchObject({
      taskId: "task-after-credit-403",
    });
    expect(posts).toBe(1);
    client.dispose();
  });

  it("aborts while waiting for Vidu capacity without posting a task", async () => {
    let posts = 0;
    const controller = new AbortController();
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes("pager.pagesz=100")) {
          return { status: 200, body: JSON.stringify({ tasks: Array.from({ length: 100 }, (_, id) => ({ id, state: "processing" })), pager: {} }) };
        }
        if (script.includes("pager.pagesz=1")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes('"method":"POST"')) {
          posts += 1;
          return { status: 200, body: JSON.stringify({ task_id: "must-not-submit" }) };
        }
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    const pending = client.submit(submitRequest("scene"), {
      throttleProbeMs: 10_000,
      onThrottled: () => controller.abort(new Error("cancelled")),
      signal: controller.signal,
    });
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" } satisfies Partial<VideoApiError>);
    expect(posts).toBe(0);
    client.dispose();
  });

  it("returns subject_limit immediately instead of retrying a rejected submit", async () => {
    let posts = 0;
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes("pager.pagesz=1")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes("pager.pagesz=100")) return { status: 200, body: JSON.stringify({ tasks: [], pager: {} }) };
        if (script.includes("pager.pagesz=5")) return { status: 200, body: JSON.stringify({ tasks: [] }) };
        if (script.includes('"method":"POST"')) {
          posts += 1;
          return { status: 429, body: JSON.stringify({ code: "ACCOUNT_SUBJECT_LIMITED", message: "主体库操作频率超限" }) };
        }
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    await expect(client.submit(submitRequest("scene"), { throttleProbeMs: 1 })).rejects.toMatchObject({
      kind: "subject_limit",
      message: "主体库操作频率超限",
    });
    expect(posts).toBe(1);
    client.dispose();
  });

  it("injects JWT cookie and localStorage and accepts the first structurally trusted endpoint", async () => {
    const token = futureJwt();
    const scripts: string[] = [];
    const browserSession = {
      fetch: vi.fn(),
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      cookies: { set: vi.fn(async () => undefined), flushStore: vi.fn(async () => undefined) },
    };
    electronMock.browserSession = browserSession;
    const window = fakeWindow({
      execute: async (script) => {
        scripts.push(script);
        if (script.includes('localStorage.setItem("token"')) return undefined;
        if (script.includes("/iam/v1/users/me")) return { status: 200, body: '{"data":{"id":"user-1"}}' };
        if (script.includes("/credit/v1/credits/me")) return { status: 200, body: "{}" };
        if (script.includes("tasks/history/me")) return { status: 200, body: '{"tasks":[]}' };
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    await expect(client.loginWithJwt(token, "ssuid-value")).resolves.toMatchObject({ status: "logged-in" });
    expect(browserSession.cookies.set).toHaveBeenCalledWith(expect.objectContaining({
      name: "JWT",
      value: token,
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
    }));
    expect(browserSession.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ name: "SSUID", value: "ssuid-value" }));
    expect(browserSession.cookies.flushStore).toHaveBeenCalledOnce();
    expect(scripts.find((script) => script.includes("localStorage.setItem"))).toContain("VIDU_STORE");
    expect(scripts.filter((script) => script.includes("/iam/v1/users/me") || script.includes("/credit/v1/credits/me") || script.includes("tasks/history/me"))).toHaveLength(1);
    client.dispose();
  });

  it("clears the partition when JWT verification fails without echoing the token", async () => {
    const token = futureJwt();
    const browserSession = {
      fetch: vi.fn(),
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      cookies: { set: vi.fn(async () => undefined), flushStore: vi.fn(async () => undefined) },
    };
    electronMock.browserSession = browserSession;
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes('localStorage.setItem("token"')) return undefined;
        if (script.includes("/iam/v1/users/me")) return { status: 200, body: "{}" };
        if (script.includes("/credit/v1/credits/me") || script.includes("tasks/history/me")) return { status: 401, body: '{"message":"unauthorized"}' };
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    const error = await client.loginWithJwt(token).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(token);
    expect(browserSession.clearStorageData).toHaveBeenCalledTimes(2);
    expect(browserSession.clearCache).toHaveBeenCalledTimes(2);
    expect(window.destroy).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("rejects HTTP 200 browser-protection HTML and unknown JSON as JWT proof", async () => {
    const token = futureJwt();
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes('localStorage.setItem("token"')) return undefined;
        if (script.includes("/iam/v1/users/me")) return { status: 200, body: "{}" };
        return { status: 200, body: "<!doctype html><html><script>window._challenge=1</script></html>" };
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    await expect(client.loginWithJwt(token)).rejects.toThrow("html_challenge");
    client.dispose();
  });

  it("checks status and polls tasks through the account session without creating a hidden window", async () => {
    electronMock.browserSession = browserSession((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/credit/v1/credits/me")) {
        return new Response('{"data":{"credits_free":1,"credits_subscribed":2,"credits_purchased":3,"credits_permanent":4}}');
      }
      if (url.includes("/tasks/task-direct")) {
        return new Response('{"id":"task-direct","state":"success","creations":[{"download_uri":"https://files.example/video.mp4"}]}');
      }
      return new Response('{"tasks":[]}');
    }) as typeof fetch);
    const client = new ViduBrowserClient(account);

    await expect(client.status()).resolves.toMatchObject({ status: "logged-in", availableCredits: 10 });
    await expect(client.poll("task-direct")).resolves.toMatchObject({ phase: "succeeded" });
    expect(electronMock.options).toHaveLength(0);
    expect(electronMock.browserSession.clearStorageData).not.toHaveBeenCalled();
    expect(electronMock.browserSession.clearCache).not.toHaveBeenCalled();
    client.dispose();
  });

  it("falls back to the signed-in Vidu page when direct task polling gets no HTTP response", async () => {
    electronMock.browserSession = browserSession((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/tasks/task-page-fallback")) throw new Error("net::ERR_TIMED_OUT");
      throw new Error(`Unexpected Vidu request: ${url}`);
    }) as typeof fetch);
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes("/tasks/task-page-fallback")) {
          return {
            status: 200,
            body: '{"id":"task-page-fallback","state":"success","creations":[{"download_uri":"https://files.example/fallback.mp4"}]}',
          };
        }
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    await expect(client.poll("task-page-fallback")).resolves.toMatchObject({
      phase: "succeeded",
      resultUrl: "https://files.example/fallback.mp4",
    });
    expect(electronMock.browserSession.fetch).toHaveBeenCalledOnce();
    expect(window.webContents.executeJavaScript).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("single-flights concurrent login checks and briefly caches only logged-in status", async () => {
    let releaseHistory!: () => void;
    const historyHeld = new Promise<void>((resolve) => { releaseHistory = resolve; });
    electronMock.browserSession = browserSession((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("tasks/history/me")) {
        await historyHeld;
        return new Response('{"tasks":[]}');
      }
      if (url.includes("/credit/v1/credits/me")) return new Response('{"credits_free":10}');
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch);
    const manager = new ViduBrowserManager();

    const first = manager.checkLogin(account);
    const second = manager.checkLogin(account);
    releaseHistory();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "logged-in" }),
      expect.objectContaining({ status: "logged-in" }),
    ]);
    await expect(manager.checkLogin(account)).resolves.toMatchObject({ status: "logged-in" });

    expect(electronMock.browserSession.fetch).toHaveBeenCalledTimes(2);
    manager.dispose();
  });

  it.each([
    ["HTML challenge", async () => new Response("<!doctype html><html><script>window._challenge=1</script></html>")],
    ["HTTP 503", async () => new Response('{"message":"unavailable"}', { status: 503 })],
    ["network error", async () => { throw new Error("network unavailable"); }],
  ] as const)("keeps %s login checks unknown and does not cache them", async (_label, fetcher) => {
    electronMock.browserSession = browserSession(fetcher as typeof fetch);
    const manager = new ViduBrowserManager();

    await expect(manager.checkLogin(account)).resolves.toMatchObject({ status: "unknown" });
    await expect(manager.checkLogin(account)).resolves.toMatchObject({ status: "unknown" });

    expect(electronMock.browserSession.fetch).toHaveBeenCalledTimes(2);
    manager.dispose();
  });

  it("preflights the real credit components before a paid submission", async () => {
    let posts = 0;
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes("/credit/v1/credits/me")) {
          return { status: 200, body: '{"data":{"credits_free":1,"credits_subscribed":"2","credits_purchased":0,"credits_permanent":0}}' };
        }
        if (script.includes('"method":"POST"')) posts += 1;
        return { status: 200, body: '{"tasks":[]}' };
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    await expect(client.submit({ ...submitRequest("scene"), useCredits: true })).rejects.toMatchObject({
      kind: "rate_limit",
      message: expect.stringContaining("可用 3"),
    });
    expect(posts).toBe(0);
    client.dispose();
  });

  it("stops retrying an ordinary submit 429 after the third attempt", async () => {
    let posts = 0;
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes("pager.pagesz=100") || script.includes("pager.pagesz=5")) {
          return { status: 200, body: '{"tasks":[],"pager":{}}' };
        }
        if (script.includes('"method":"POST"')) {
          posts += 1;
          return { status: 429, body: '{"message":"too many requests"}' };
        }
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 160)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    await expect(client.submit(submitRequest("scene"), { throttleProbeMs: 1 })).rejects.toMatchObject({ kind: "rate_limit" });
    expect(posts).toBe(3);
    client.dispose();
  });

  it("sums nested credit components and fingerprints the actual asset bytes", async () => {
    expect(extractAvailableViduCredits({ data: { credits_free: "1,000", credits_subscribed: 2, credits_purchased: 3 } })).toBe(1_005);
    const directory = await mkdtemp(join(tmpdir(), "ai-tool-vidu-fingerprint-"));
    temporaryDirectories.push(directory);
    const asset = join(directory, "role.png");
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    await writeFile(asset, "AAAA");
    await utimes(asset, fixedTime, fixedTime);
    const first = await fingerprintViduAsset(asset);
    await writeFile(asset, "BBBB");
    await utimes(asset, fixedTime, fixedTime);
    const second = await fingerprintViduAsset(asset);

    expect(first).not.toBe(second);
  });

  it("selects old-project subjects before the farthest future project subject", () => {
    const material = (name: string, id: string) => ({ id, name, version: "1", url: `https://files/${id}`, raw: {} });
    const oldProject = material("旧项目角色", "old");
    const soon = material("即将出场", "soon");
    const far = material("很晚出场", "far");
    const needed = material("当前角色", "needed");
    const candidates = [
      { material: soon, belongsToProject: true, nextAppearance: 2 },
      { material: needed, belongsToProject: true, nextAppearance: 99 },
      { material: far, belongsToProject: true, nextAppearance: 20 },
      { material: oldProject, belongsToProject: false, nextAppearance: null },
    ];

    expect(chooseViduReplacementCandidate(candidates, new Set(["当前角色"]))).toBe(oldProject);
    expect(chooseViduReplacementCandidate(candidates.slice(0, 3), new Set(["当前角色"]))).toBe(far);
  });

  it("uses 10/20 second audit cooldowns and retries only transient material failures", () => {
    expect(viduMaterialRetryDelay("pre-process", 400, "AuditSubmitIllegal", 1)).toBe(10_000);
    expect(viduMaterialRetryDelay("pre-process", 400, "AuditSubmitIllegal", 2)).toBe(20_000);
    expect(viduMaterialRetryDelay("create", 429, "rate limited", 1)).toBe(3_000);
    expect(viduMaterialRetryDelay("edit", 503, "unavailable", 1)).toBe(3_000);
    expect(viduMaterialRetryDelay("create", 400, "library full", 1)).toBeNull();
  });

  it("reads every subject-library page and stores only sanitized subject metadata", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `subject-${index}`,
      type: "user",
      name: `主体 ${index}`,
      modality: "image",
      labels: index === 0 ? [{ style: "国漫", token: "must-not-persist" }] : [],
      voice: index === 0 ? { id: "voice-1", jwt: "must-not-persist", nested: { cookie: "must-not-persist", language: "zh" } } : {},
      components: [{
        type: "main",
        content_type: "image",
        selected_region: { top_left: { x: 0, y: 0 }, bottom_right: { x: 1024, y: 1024 } },
        content: `https://cdn.example.com/content-${index}.jpg`,
        src_img: `https://cdn.example.com/source-${index}.jpg`,
      }],
    }));
    const scripts: string[] = [];
    const window = fakeWindow({
      execute: async (script) => {
        scripts.push(script);
        if (script.includes("pager.page_token=page-2")) {
          return { status: 200, body: JSON.stringify({ elements: [{ ...firstPage[0], id: "subject-100", name: "主体 100" }], pager: {} }) };
        }
        return { status: 200, body: JSON.stringify({ elements: firstPage, pager: { next_page_token: "page-2" } }) };
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    const clipboard = await client.exportSubjectLibrary();

    expect(clipboard.subjects).toHaveLength(101);
    expect(scripts.filter((script) => script.includes("material/elements/personal"))).toHaveLength(2);
    expect(clipboard.subjects[0]).toMatchObject({
      name: "主体 0",
      labels: [{ style: "国漫" }],
      voice: { id: "voice-1", nested: { language: "zh" } },
      components: [{ contentUrl: "https://cdn.example.com/content-0.jpg", sourceImageUrl: "https://cdn.example.com/source-0.jpg" }],
    });
    expect(JSON.stringify(clipboard)).not.toMatch(/must-not-persist|jwt|cookie/u);
    client.dispose();
  });

  it("validates a persisted subject clipboard and strips credential-like metadata", () => {
    const parsed = parseViduSubjectClipboard({
      version: 1,
      copiedAt: "2026-07-27T00:00:00.000Z",
      sourceAccountName: "来源账号",
      subjects: [{
        name: "多组件主体",
        labels: [{ style: "国漫", api_key: "secret" }],
        voice: { id: "voice-1", access_token: "secret" },
        modality: "image",
        components: [
          { type: "main", contentType: "image", selectedRegion: {}, contentUrl: "https://cdn.example.com/a.jpg", sourceImageUrl: "" },
          { type: "reference", contentType: "image", selectedRegion: {}, contentUrl: "", sourceImageUrl: "https://cdn.example.com/b.jpg" },
        ],
      }],
    });

    expect(parsed.subjects[0]).toMatchObject({ labels: [{ style: "国漫" }], voice: { id: "voice-1" } });
    expect(parsed.subjects[0].components).toHaveLength(2);
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  it("downloads and uploads every component before preserving metadata in preprocess and create", async () => {
    const scripts: string[] = [];
    let uploadIndex = 0;
    let finishIndex = 0;
    electronMock.browserSession = browserSession((async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response("", { status: 200, headers: { etag: `\"etag-${uploadIndex}\"` } });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch);
    const window = fakeWindow({
      execute: async (script) => {
        scripts.push(script);
        if (script.includes("/tools/v1/files/uploads/") && script.includes("/finish")) {
          finishIndex += 1;
          return { status: 200, body: JSON.stringify({ uri: `ssupload:?id=upload-${finishIndex}` }) };
        }
        if (script.includes("/tools/v1/files/uploads") && script.includes('"method":"POST"')) {
          uploadIndex += 1;
          return { status: 200, body: JSON.stringify({ id: `upload-${uploadIndex}`, put_url: `https://upload.example.com/${uploadIndex}` }) };
        }
        if (script.includes("material/elements/pre-process")) return { status: 200, body: JSON.stringify({ id: "prepared-1", recaption: {} }) };
        if (script.includes("/vidu/v1/material/elements") && script.includes('"method":"POST"')) return { status: 200, body: JSON.stringify({ id: "created-1" }) };
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 180)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);
    const clipboard = parseViduSubjectClipboard({
      version: 1,
      copiedAt: "2026-07-27T00:00:00.000Z",
      sourceAccountName: "来源账号",
      subjects: [{
        name: "角色甲",
        labels: ["主角", "国漫"],
        voice: { id: "voice-1", language: "zh" },
        modality: "image",
        components: [
          {
            type: "main",
            contentType: "image",
            selectedRegion: { top_left: { x: 0, y: 0 }, bottom_right: { x: 640, y: 960 } },
            contentUrl: "https://cdn.example.com/content.jpg",
            sourceImageUrl: "https://cdn.example.com/source.jpg",
          },
          {
            type: "reference",
            contentType: "image",
            selectedRegion: { top_left: { x: 0, y: 0 }, bottom_right: { x: 320, y: 480 } },
            contentUrl: "https://cdn.example.com/reference.jpg",
            sourceImageUrl: "",
          },
        ],
      }],
    });

    await expect(client.importSubjectLibrary(clipboard)).resolves.toMatchObject({ total: 1, success: 1, failed: 0 });
    expect(electronMock.browserSession.fetch).toHaveBeenCalledTimes(6);
    expect(uploadIndex).toBe(3);
    expect(finishIndex).toBe(3);
    const uploadInitializations = scripts.filter((script) => script.includes("/tools/v1/files/uploads") && !script.includes("/finish"));
    expect(uploadInitializations).toHaveLength(3);
    uploadInitializations.forEach((script) => {
      expect(script).toContain('\\"image-height\\":\\"1200\\"');
      expect(script).toContain('\\"image-width\\":\\"800\\"');
    });
    const preprocess = scripts.find((script) => script.includes("pre-process")) ?? "";
    const create = scripts.find((script) => script.includes("/vidu/v1/material/elements") && !script.includes("pre-process")) ?? "";
    for (const script of [preprocess, create]) {
      expect(script).toContain('\\"name\\":\\"角色甲\\"');
      expect(script).toContain('\\"labels\\":[\\"主角\\",\\"国漫\\"]');
      expect(script).toContain('\\"voice\\":{\\"id\\":\\"voice-1\\",\\"language\\":\\"zh\\"}');
      expect(script).toContain('\\"type\\":\\"reference\\"');
    }
    expect(create).toContain('\\"modality\\":\\"image\\"');
    client.dispose();
  });

  it("imports at most three subjects concurrently and keeps result order stable", async () => {
    const client = new ViduBrowserClient(account);
    const clipboard = parseViduSubjectClipboard({
      version: 1,
      copiedAt: "2026-07-27T00:00:00.000Z",
      sourceAccountName: "来源账号",
      subjects: Array.from({ length: 7 }, (_, index) => ({
        name: `角色 ${index}`,
        labels: [],
        voice: {},
        modality: "image",
        components: [{
          type: "main",
          contentType: "image",
          selectedRegion: {},
          contentUrl: `https://cdn.example.com/${index}.jpg`,
          sourceImageUrl: "",
        }],
      })),
    });
    let active = 0;
    let maxActive = 0;
    const importSubject = vi.spyOn(client as unknown as {
      importSubject(subject: ReturnType<typeof parseViduSubjectClipboard>["subjects"][number]): Promise<void>;
    }, "importSubject").mockImplementation(async (subject) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const index = Number(subject.name.split(" ")[1]);
      await new Promise((resolve) => setTimeout(resolve, (7 - index) * 2));
      active -= 1;
      if (index === 2) throw new Error("provider rejected");
    });

    const result = await client.importSubjectLibrary(clipboard);

    expect(importSubject).toHaveBeenCalledTimes(7);
    expect(maxActive).toBe(3);
    expect(result).toMatchObject({ total: 7, success: 6, failed: 1 });
    expect(result.results.map((item) => item.name)).toEqual(Array.from({ length: 7 }, (_, index) => `角色 ${index}`));
    expect(result.results[2]).toEqual({ name: "角色 2", status: "failed", message: "provider rejected" });
    client.dispose();
  });

  it("reports an undecodable downloaded subject image as that item's failure", async () => {
    electronMock.createFromBuffer.mockReturnValueOnce({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) });
    electronMock.browserSession = browserSession((async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    })) as typeof fetch);
    const client = new ViduBrowserClient(account);
    const clipboard = parseViduSubjectClipboard({
      version: 1,
      copiedAt: "2026-07-27T00:00:00.000Z",
      sourceAccountName: "来源账号",
      subjects: [{
        name: "损坏图片主体",
        labels: [],
        voice: {},
        modality: "image",
        components: [{
          type: "main",
          contentType: "image",
          selectedRegion: {},
          contentUrl: "https://cdn.example.com/broken.jpg",
          sourceImageUrl: "",
        }],
      }],
    });

    await expect(client.importSubjectLibrary(clipboard)).resolves.toMatchObject({
      total: 1,
      success: 0,
      failed: 1,
      results: [{ name: "损坏图片主体", status: "failed", message: expect.stringContaining("无法解码") }],
    });
    expect(electronMock.options).toHaveLength(0);
    client.dispose();
  });

  it("reports each real clear-subject success and failure instead of counting attempts", async () => {
    const window = fakeWindow({
      execute: async (script) => {
        if (script.includes("material/elements/personal")) {
          return { status: 200, body: JSON.stringify({ elements: [
            { id: "delete-ok", name: "可删除", type: "user" },
            { id: "delete-fail", name: "删除失败", type: "user" },
          ], pager: {} }) };
        }
        if (script.includes("delete-ok")) return { status: 204, body: "" };
        if (script.includes("delete-fail")) return { status: 500, body: '{"message":"provider rejected"}' };
        throw new Error(`Unexpected Vidu script: ${script.slice(0, 180)}`);
      },
    });
    electronMock.windows.push(window);
    const client = new ViduBrowserClient(account);

    const result = await client.clearSubjectLibrary();

    expect(result).toMatchObject({ total: 2, success: 1, failed: 1 });
    expect(result.results).toEqual([
      { name: "可删除", status: "success", message: "主体已删除" },
      { name: "删除失败", status: "failed", message: "provider rejected" },
    ]);
    client.dispose();
  });

  it.each([0, 429, 503])("keeps polling after transient task status %s and completes the same task", async (httpStatus) => {
    const client = new ViduBrowserClient(account);
    const poll = vi.spyOn(client, "poll")
      .mockRejectedValueOnce(new VideoApiError("unavailable", `HTTP ${httpStatus}`, httpStatus))
      .mockResolvedValueOnce({
        taskId: "task-transient-recovery",
        phase: "succeeded",
        providerStatus: "success",
        progress: 100,
        resultUrl: "https://files.example/task-transient-recovery.mp4",
        error: null,
        raw: {},
      });

    await expect(client.waitForResult("task-transient-recovery", {
      timeoutMs: 100,
      pollIntervalMs: 1,
    })).resolves.toMatchObject({ phase: "succeeded" });
    expect(poll).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it("stops transient polling at the overall timeout", async () => {
    const client = new ViduBrowserClient(account);
    vi.spyOn(client, "poll").mockRejectedValue(new VideoApiError("unavailable", "HTTP 503", 503));

    await expect(client.waitForResult("task-timeout", {
      timeoutMs: 12,
      pollIntervalMs: 2,
    })).rejects.toMatchObject({ kind: "timeout" });
    client.dispose();
  });

  it("aborts immediately while waiting to retry a transient poll", async () => {
    const client = new ViduBrowserClient(account);
    const controller = new AbortController();
    const poll = vi.spyOn(client, "poll").mockRejectedValue(new VideoApiError("unavailable", "HTTP 503", 503));
    const waiting = client.waitForResult("task-cancelled", {
      signal: controller.signal,
      timeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
    await vi.waitFor(() => expect(poll).toHaveBeenCalledOnce());
    controller.abort(new Error("cancelled by user"));

    await expect(waiting).rejects.toThrow("cancelled by user");
    client.dispose();
  });

  it.each([
    new VideoApiError("authentication", "login expired", 401),
    new VideoApiError("not_found", "task missing", 404),
  ])("does not retry a non-transient task lookup error", async (failure) => {
    const client = new ViduBrowserClient(account);
    const poll = vi.spyOn(client, "poll").mockRejectedValue(failure);

    await expect(client.waitForResult("task-terminal", { timeoutMs: 100, pollIntervalMs: 1 }))
      .rejects.toBe(failure);
    expect(poll).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("does not retry a provider-declared task failure", async () => {
    const client = new ViduBrowserClient(account);
    const poll = vi.spyOn(client, "poll").mockResolvedValue({
      taskId: "task-provider-failed",
      phase: "failed",
      providerStatus: "failed",
      progress: 20,
      resultUrl: null,
      error: "provider rejected",
      raw: {},
    });

    await expect(client.waitForResult("task-provider-failed", { timeoutMs: 100, pollIntervalMs: 1 }))
      .rejects.toMatchObject({ kind: "provider_failed", message: "provider rejected" });
    expect(poll).toHaveBeenCalledOnce();
    client.dispose();
  });
});
