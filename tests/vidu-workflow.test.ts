import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../src/main/database";
import { JobStore, PersistentJobQueue } from "../src/main/jobs";
import {
  CharacterProfileRepository,
  ProjectRepository,
  SettingsRepository,
  StoryboardRepository,
  ViduAccountRepository,
} from "../src/main/repositories";
import type { ViduGenerationClient, ViduSubmitRequest } from "../src/main/vidu-protocol";
import { VideoApiError } from "../src/main/video-client";
import { checkViduSubmissionNow, registerVideoWorkflowHandler } from "../src/main/video-workflow";
import { enqueuePersistedViduRecoveries } from "../src/main/video-recovery";
import type { ViduAccount, ViduAccountStatus } from "../src/shared/contracts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("Vidu browser video workflow", () => {
  let root: string;
  let database: AppDatabase;
  let queue: PersistentJobQueue;
  let projects: ProjectRepository;
  let characterProfiles: CharacterProfileRepository;
  let storyboards: StoryboardRepository;
  let settings: SettingsRepository;
  let accounts: ViduAccountRepository;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ai-tool-vidu-workflow-"));
    database = new AppDatabase(":memory:");
    projects = new ProjectRepository(database.connection);
    characterProfiles = new CharacterProfileRepository(database.connection);
    storyboards = new StoryboardRepository(database.connection);
    settings = new SettingsRepository(database.connection);
    accounts = new ViduAccountRepository(database.connection);
    settings.set("video_provider", "vidu-browser");
    settings.set("vidu_model", "Q3");
    settings.set("vidu_use_credits", "true");
    settings.set("vidu_account_dispatch_mode", "parallel");
    settings.set("vidu_show_active_browser", "false");
    settings.set("video_aspect_ratio", "3:4");
    settings.set("vidu_poll_interval_ms", "250");
    settings.set("video_timeout_ms", "5000");
    await mkdir(join(root, "资产图"), { recursive: true });
    await writeFile(join(root, "资产图", "小李.png"), Buffer.from("asset"));
  });

  afterEach(async () => {
    await queue?.shutdown();
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  function fixture() {
    const account = accounts.create("主账号");
    const project = projects.create({ name: "Vidu project", folderPath: root });
    const storyboard = storyboards.replace(project.id, [{
      index: 0,
      originalText: "小李进入店内",
      subjects: ["小李"],
      prompt: "@小李 进入商店",
      duration: 6,
    }])[0];
    return { account, storyboard };
  }

  function fakeClient(overrides: Partial<ViduGenerationClient> = {}): ViduGenerationClient {
    return {
      submit: vi.fn(async () => ({ taskId: "vidu-task-1", raw: { id: "vidu-task-1" } })),
      poll: vi.fn(async (taskId) => ({ taskId, phase: "running" as const, providerStatus: "processing", progress: 20, resultUrl: null, error: null, raw: {} })),
      waitForResult: vi.fn(async (taskId) => ({ taskId, phase: "succeeded" as const, providerStatus: "success", progress: 100, resultUrl: "https://files.example/vidu.mp4", error: null, raw: {} })),
      downloadResult: vi.fn(async (_url, options) => {
        await mkdir(options.outputDirectory, { recursive: true });
        const path = join(options.outputDirectory, "vidu.mp4");
        await writeFile(path, Buffer.from("video"));
        return { path, bytes: 5, mimeType: "video/mp4" };
      }),
      ...overrides,
    };
  }

  function start(
    client: ViduGenerationClient | Map<string, ViduGenerationClient>,
    recoverPersisted = false,
    concurrency = 1,
    checkLogin: (account: ViduAccount) => Promise<ViduAccountStatus> = vi.fn(async (account: ViduAccount) => ({
      accountId: account.id,
      status: "logged-in" as const,
      httpStatus: 200,
      message: "ok",
    })),
    openLogin: (account: ViduAccount) => Promise<void> = vi.fn(async () => undefined),
  ): void {
    queue = new PersistentJobQueue(new JobStore(database.connection), concurrency);
    registerVideoWorkflowHandler(queue, {
      settings,
      storyboards,
      projects,
      characterProfiles,
      projectsRoot: root,
      viduAccounts: accounts,
      viduBrowser: {
        checkLogin,
        openLogin,
        client: vi.fn((account) => client instanceof Map ? client.get(account.id)! : client),
      },
    });
    if (recoverPersisted) enqueuePersistedViduRecoveries(queue, storyboards, { minimumAgeMs: 0 });
    queue.start();
  }

  it("submits with the selected local account and persists ownership before download", async () => {
    const { account, storyboard } = fixture();
    settings.set("vidu_default_account_id", account.id);
    const client = fakeClient();
    start(client);

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(client.submit).toHaveBeenCalledWith(expect.objectContaining({
      projectId: storyboard.projectId,
      prompt: "@小李 进入商店",
      subjects: ["小李"],
      durationSeconds: 6,
      model: "Q3",
      useCredits: true,
      aspectRatio: "3:4",
    } satisfies Partial<ViduSubmitRequest>), expect.any(Object));
    expect(client.downloadResult).toHaveBeenCalledWith("https://files.example/vidu.mp4", expect.objectContaining({
      outputDirectory: join(root, "videos", "browser_1"),
      stem: "1",
      fileName: "1.mp4",
    }));
    expect(queue.store.require(job.id)).toMatchObject({
      status: "done",
      output: { provider: "vidu-browser", accountId: account.id, providerTaskId: "vidu-task-1" },
    });
    expect(storyboards.get(storyboard.id)).toMatchObject({
      videoTaskId: null,
      videoProvider: "vidu-browser",
      videoAccountId: account.id,
      videoSubmissionState: "idle",
      submitCount: 1,
    });
  });

  it("falls back to an available account when the persisted default account was deleted", async () => {
    const { account, storyboard } = fixture();
    const deletedAccountId = "4c34dd84-0543-4a09-bfdf-3ce28ff0519d";
    settings.set("vidu_default_account_id", deletedAccountId);
    const client = fakeClient();
    start(client);
    expect(settings.get("vidu_default_account_id")).toBe("");

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(queue.store.require(job.id)).toMatchObject({
      status: "done",
      output: { accountId: account.id, providerTaskId: "vidu-task-1" },
    });
  });

  it("does not silently replace an explicitly selected account that no longer exists", async () => {
    const { storyboard } = fixture();
    const deletedAccountId = "4c34dd84-0543-4a09-bfdf-3ce28ff0519d";
    const client = fakeClient();
    start(client);

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id, accountId: deletedAccountId });
    await queue.waitForIdle();

    expect(client.submit).not.toHaveBeenCalled();
    expect(queue.store.require(job.id)).toMatchObject({
      status: "error",
      error: expect.stringContaining(`Vidu 账号不存在: ${deletedAccountId}`),
    });
  });

  it("persists PREP_START, PREP, and PREP_END-equivalent subject registration progress", async () => {
    const { storyboard } = fixture();
    const client = fakeClient({
      submit: vi.fn(async (_request, options) => {
        options?.onSubjectPreparation?.({ phase: "start", current: 0, total: 2, name: "小李" });
        options?.onSubjectPreparation?.({ phase: "progress", current: 1, total: 2, name: "小李" });
        options?.onSubjectPreparation?.({ phase: "progress", current: 2, total: 2, name: "店长" });
        options?.onSubjectPreparation?.({ phase: "end", current: 2, total: 2, name: "店长" });
        return { taskId: "vidu-prep", raw: {} };
      }),
    });
    start(client);

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    const prepEvents = queue.store.events(job.id)
      .filter((event) => (event.detail as { kind?: string } | null)?.kind === "subject-prep")
      .map((event) => event.detail as { event: string; phase: string; current: number; total: number; name: string });
    expect(prepEvents.map(({ event }) => event)).toEqual(["PREP_START", "PREP", "PREP", "PREP_END"]);
    expect(prepEvents.at(-1)).toMatchObject({ phase: "end", current: 2, total: 2, name: "店长" });
  });

  it("checks a persisted Vidu task immediately and records the provider status", async () => {
    const { account, storyboard } = fixture();
    storyboards.saveVideoProviderTask(storyboard.id, "vidu-check-now", "vidu-browser", account.id);
    const client = fakeClient({
      poll: vi.fn(async (taskId) => ({
        taskId,
        phase: "running" as const,
        providerStatus: "processing",
        progress: 37,
        resultUrl: null,
        error: null,
        raw: {},
      })),
    });
    const result = await checkViduSubmissionNow({
      storyboards,
      accounts,
      storyboardId: storyboard.id,
      browser: {
        checkLogin: vi.fn(async () => ({ accountId: account.id, status: "logged-in" as const, httpStatus: 200, message: "ok" })),
        client: vi.fn(() => client),
      },
    });

    expect(client.poll).toHaveBeenCalledWith("vidu-check-now", expect.any(Object));
    expect(result).toMatchObject({ phase: "running", providerStatus: "processing", progress: 37 });
    expect(storyboards.get(storyboard.id)).toMatchObject({
      videoRecoveryState: "processing",
      videoRecoveryMessage: "Vidu 任务状态: processing",
    });
    const checkEvents = storyboards.events(storyboard.id);
    expect(checkEvents.map((event) => event.eventType)).toContain("manual_check_start");
    expect(checkEvents.map((event) => event.eventType)).toContain("manual_check_result");
    expect(checkEvents.find((event) => event.eventType === "manual_check_start")).toMatchObject({
      message: "手动检查开始",
      detail: { source: "manual" },
    });
    expect(checkEvents.some((event) => event.eventType.startsWith("patrol_"))).toBe(false);
    expect(storyboards.viduRecoveryState(storyboard.id)).toMatchObject({ leaseOwner: "", leaseUntilMs: 0 });
  });

  it("does not run a manual check while a background recovery lease is active", async () => {
    const { account, storyboard } = fixture();
    storyboards.saveVideoProviderTask(storyboard.id, "vidu-background-recovery", "vidu-browser", account.id);
    expect(storyboards.claimViduRecoveryLease(
      storyboard.id,
      "vidu-background-recovery",
      "recovery-worker",
    )).toBe(true);
    const client = fakeClient();

    await expect(checkViduSubmissionNow({
      storyboards,
      accounts,
      storyboardId: storyboard.id,
      browser: {
        checkLogin: vi.fn(async () => ({ accountId: account.id, status: "logged-in" as const, httpStatus: 200, message: "ok" })),
        client: vi.fn(() => client),
      },
    })).rejects.toThrow();

    expect(client.poll).not.toHaveBeenCalled();
    expect(storyboards.viduRecoveryState(storyboard.id)).toMatchObject({ leaseOwner: "recovery-worker" });
    expect(storyboards.events(storyboard.id).some((event) => event.eventType === "manual_check_start")).toBe(false);
  });

  it("records a failed manual check and always releases its lease", async () => {
    const { account, storyboard } = fixture();
    storyboards.saveVideoProviderTask(storyboard.id, "vidu-manual-failure", "vidu-browser", account.id);
    const client = fakeClient({
      poll: vi.fn(async () => { throw new VideoApiError("network", "offline"); }),
    });

    await expect(checkViduSubmissionNow({
      storyboards,
      accounts,
      storyboardId: storyboard.id,
      browser: {
        checkLogin: vi.fn(async () => ({ accountId: account.id, status: "logged-in" as const, httpStatus: 200, message: "ok" })),
        client: vi.fn(() => client),
      },
    })).rejects.toThrow("offline");

    expect(client.poll).toHaveBeenCalledTimes(1);
    const checkEvents = storyboards.events(storyboard.id);
    expect(checkEvents.map((event) => event.eventType)).toContain("manual_check_start");
    expect(checkEvents.map((event) => event.eventType)).toContain("manual_check_failed");
    expect(checkEvents.some((event) => event.eventType.startsWith("patrol_"))).toBe(false);
    expect(storyboards.viduRecoveryState(storyboard.id)).toMatchObject({
      lastResult: "unavailable",
      leaseOwner: "",
      leaseUntilMs: 0,
    });
  });

  it("uses Q3 only for the configured leading storyboard count", async () => {
    const account = accounts.create("Q3 前置账号");
    const project = projects.create({ name: "Q3 前置项目", folderPath: root });
    const items = storyboards.replace(project.id, [0, 1, 2].map((index) => ({
      index,
      originalText: `分镜 ${index + 1}`,
      prompt: `画面 ${index + 1}`,
      duration: 4,
    })));
    settings.set("vidu_default_account_id", account.id);
    settings.set("vidu_use_credits", "false");
    const client = fakeClient();
    start(client);

    items.forEach((storyboard) => queue.enqueue("video.generate", {
      storyboardId: storyboard.id,
      q3PreCount: 2,
      viduModel: "Q3",
    }));
    await queue.waitForIdle();
    queue.enqueue("video.generate", { storyboardId: items[2].id, q3PreCount: 0, viduModel: "Q2" });
    await queue.waitForIdle();

    expect(client.submit).toHaveBeenCalledTimes(4);
    const submissions = vi.mocked(client.submit).mock.calls.map(([request]) => ({
      prompt: request.prompt,
      model: request.model,
      useCredits: request.useCredits,
    }));
    expect(submissions.filter(({ prompt }) => prompt === "画面 1")).toEqual([{ prompt: "画面 1", model: "Q3", useCredits: true }]);
    expect(submissions.filter(({ prompt }) => prompt === "画面 2")).toEqual([{ prompt: "画面 2", model: "Q3", useCredits: true }]);
    expect(submissions.filter(({ prompt }) => prompt === "画面 3").map(({ model }) => model).sort()).toEqual(["Q2", "Q3"]);
    expect(submissions.filter(({ prompt }) => prompt === "画面 3").map(({ model, useCredits }) => ({ model, useCredits })))
      .toEqual([
        { model: "Q2", useCredits: false },
        { model: "Q3", useCredits: true },
      ]);
  });

  it("forces credits for Q3 even when the queued input explicitly disables them", async () => {
    const { account, storyboard } = fixture();
    settings.set("vidu_default_account_id", account.id);
    settings.set("vidu_use_credits", "false");
    const client = fakeClient();
    start(client);

    queue.enqueue("video.generate", {
      storyboardId: storyboard.id,
      viduModel: "Q3",
      useCredits: false,
    });
    await queue.waitForIdle();

    expect(client.submit).toHaveBeenCalledWith(
      expect.objectContaining({ model: "Q3", useCredits: true }),
      expect.any(Object),
    );
  });

  it("keeps sparse original indexes for the Q3 threshold and downloaded file names", async () => {
    const account = accounts.create("跳号账号");
    const project = projects.create({ name: "跳号项目", folderPath: root });
    const items = storyboards.replace(project.id, [
      { index: 0, originalText: "第一镜", prompt: "画面 1", duration: 4 },
      { index: 2, originalText: "第三镜", prompt: "画面 3", duration: 4 },
    ]);
    settings.set("vidu_default_account_id", account.id);
    const client = fakeClient();
    start(client);

    items.forEach((storyboard) => queue.enqueue("video.generate", {
      storyboardId: storyboard.id,
      q3PreCount: 2,
      viduModel: "Q3",
    }));
    await queue.waitForIdle();

    expect(vi.mocked(client.submit).mock.calls.map(([request]) => ({
      storyboardIndex: request.storyboardIndex,
      model: request.model,
    })).sort((left, right) => (left.storyboardIndex ?? 0) - (right.storyboardIndex ?? 0))).toEqual([
      { storyboardIndex: 1, model: "Q3" },
      { storyboardIndex: 3, model: "Q2" },
    ]);
    expect(vi.mocked(client.downloadResult).mock.calls.map(([, options]) => options.fileName))
      .toEqual(expect.arrayContaining(["1.mp4", "3.mp4"]));
  });

  it("canonicalizes profile aliases before Vidu material lookup and submit", async () => {
    const account = accounts.create("别名账号");
    const project = projects.create({ name: "别名项目", folderPath: root });
    characterProfiles.replace(project.id, [
      { name: "洛川", aliases: ["阿洛"], visualPrompt: "年轻剑客", assetType: "character" },
      { name: "北境旧城", aliases: ["旧城"], visualPrompt: "覆雪边城", assetType: "scene" },
    ]);
    await writeFile(join(root, "资产图", "洛川.png"), Buffer.from("character"));
    await writeFile(join(root, "资产图", "北境旧城.webp"), Buffer.from("scene"));
    const [storyboard] = storyboards.replace(project.id, [
      {
        index: 0,
        originalText: "阿洛进入旧城",
        subjects: ["阿洛"],
        prompt: "@阿洛 进入 @旧城",
        duration: 4,
      },
      {
        index: 3,
        originalText: "旧城再会",
        subjects: ["阿洛", "旧城"],
        prompt: "@阿洛 重返 @旧城",
        duration: 4,
      },
    ]);
    settings.set("vidu_default_account_id", account.id);
    const client = fakeClient();
    start(client);

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id).status).toBe("done");
    expect(client.submit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "@洛川 进入 @北境旧城",
      subjects: ["洛川"],
      storyboardIndex: 1,
      nextSubjectAppearances: { 洛川: 4, 北境旧城: 4 },
    }), expect.any(Object));
  });

  it("blocks Vidu submit when a referenced special-space asset is missing", async () => {
    const account = accounts.create("资产预检账号");
    const project = projects.create({ name: "资产预检项目", folderPath: root });
    characterProfiles.replace(project.id, [{
      name: "镜中秘境",
      aliases: ["秘境"],
      visualPrompt: "无限延伸的镜面异空间",
      assetType: "special-space",
    }]);
    const [storyboard] = storyboards.replace(project.id, [{
      index: 0,
      originalText: "进入秘境",
      prompt: "镜头穿过 @秘境",
      duration: 4,
    }]);
    settings.set("vidu_default_account_id", account.id);
    const client = fakeClient();
    start(client);

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({
      status: "error",
      error: expect.stringContaining("镜中秘境"),
    });
    expect(client.submit).not.toHaveBeenCalled();
    expect(storyboards.get(storyboard.id)).toMatchObject({
      videoTaskId: null,
      videoSubmissionState: "idle",
    });
  });

  it("keeps the Q3 leading count in a persisted queued job after queue recreation", async () => {
    const account = accounts.create("恢复账号");
    const project = projects.create({ name: "恢复项目", folderPath: root });
    const storyboard = storyboards.replace(project.id, [0, 1, 2].map((index) => ({
      index,
      originalText: `分镜 ${index + 1}`,
      prompt: `画面 ${index + 1}`,
      duration: 4,
    })))[2];
    settings.set("vidu_default_account_id", account.id);
    const persisted = new JobStore(database.connection).enqueue("video.generate", {
      storyboardId: storyboard.id,
      q3PreCount: 2,
      viduModel: "Q3",
    });
    const client = fakeClient();

    start(client);
    await queue.waitForIdle();

    expect(queue.store.require(persisted.id)).toMatchObject({
      status: "done",
      input: { storyboardId: storyboard.id, q3PreCount: 2 },
    });
    expect(client.submit).toHaveBeenCalledWith(expect.objectContaining({ model: "Q2" }), expect.any(Object));
  });

  it("resumes the persisted Vidu task without another external submit", async () => {
    const { account, storyboard } = fixture();
    storyboards.saveVideoProviderTask(storyboard.id, "vidu-existing", "vidu-browser", account.id);
    const client = fakeClient();
    start(client);

    queue.enqueue("video.generate", { storyboardId: storyboard.id, provider: "custom-api" });
    await queue.waitForIdle();

    expect(client.submit).not.toHaveBeenCalled();
    expect(client.waitForResult).toHaveBeenCalledWith("vidu-existing", expect.any(Object));
  });

  it("marks an uncertain submit and blocks automatic retry", async () => {
    const { account, storyboard } = fixture();
    const fallback = accounts.create("不应切换的备用账号");
    settings.set("vidu_default_account_id", account.id);
    const client = fakeClient({
      submit: vi.fn(async () => {
        throw new VideoApiError("invalid_response", "Vidu 已接受提交但未返回 task_id", 200);
      }),
    });
    const unused = fakeClient();
    start(new Map([[account.id, client], [fallback.id, unused]]));

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({ status: "error" });
    expect(storyboards.get(storyboard.id)).toMatchObject({
      videoTaskId: null,
      videoProvider: "vidu-browser",
      videoAccountId: account.id,
      videoSubmissionState: "uncertain",
    });
    const retry = queue.retry(job.id);
    await queue.waitForIdle();
    expect(queue.store.require(retry.id)).toMatchObject({ status: "error", error: expect.stringContaining("结果不确定") });
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(unused.submit).not.toHaveBeenCalled();
  });

  it("switches to the next account only after a definite quota rejection", async () => {
    const { account: first, storyboard } = fixture();
    settings.set("vidu_account_dispatch_mode", "sequential");
    settings.set("vidu_show_active_browser", "true");
    accounts.update(first.id, { accountType: "points", defaultQuota: 46 });
    const second = accounts.create("备用账号", { accountType: "member", defaultQuota: 200 });
    settings.set("vidu_default_account_id", first.id);
    const rejected = fakeClient({
      submit: vi.fn(async () => { throw new VideoApiError("rate_limit", "Vidu 积分不足", 429); }),
    });
    const accepted = fakeClient({
      submit: vi.fn(async () => ({ taskId: "vidu-task-fallback", raw: {} })),
    });
    const openLogin = vi.fn(async (_account: ViduAccount) => undefined);
    start(new Map([[first.id, rejected], [second.id, accepted]]), false, 1, undefined, openLogin);

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(rejected.submit).toHaveBeenCalledTimes(1);
    expect(accepted.submit).toHaveBeenCalledTimes(1);
    expect(openLogin).not.toHaveBeenCalled();
    expect(accounts.get(first.id)).toMatchObject({ enabled: true, disabledReason: null });
    expect(queue.store.require(job.id)).toMatchObject({
      status: "done",
      output: { accountId: second.id, providerTaskId: "vidu-task-fallback" },
    });
  });

  it("keeps five account channels occupied until their tasks finish, then runs the next wave", async () => {
    const pool = Array.from({ length: 5 }, (_, index) => accounts.create(
      `并行账号 ${index + 1}`,
      { accountType: "points", defaultQuota: 46 },
    ));
    const project = projects.create({ name: "并发项目", folderPath: root });
    const rows = storyboards.replace(project.id, Array.from({ length: 10 }, (_, index) => ({
      index,
      originalText: `小李镜头 ${index + 1}`,
      subjects: ["小李"],
      prompt: `@小李 镜头 ${index + 1}`,
      duration: 4,
    })));
    settings.set("vidu_default_account_id", pool[0].id);
    const firstWave = deferred<void>();
    const makeClient = (suffix: string) => {
      let submitted = 0;
      return fakeClient({
        submit: vi.fn(async () => {
          submitted += 1;
          return { taskId: `vidu-concurrent-${suffix}-${submitted}`, raw: {} };
        }),
        waitForResult: vi.fn(async (taskId) => {
          if (submitted === 1) await firstWave.promise;
          return { taskId, phase: "succeeded" as const, providerStatus: "success", progress: 100, resultUrl: `https://files.example/${taskId}.mp4`, error: null, raw: {} };
        }),
      });
    };
    const clients = pool.map((account, index) => [account.id, makeClient(String(index + 1))] as const);
    start(new Map(clients), false, 10);

    const jobs = rows.map((row) => queue.enqueue("video.generate", { storyboardId: row.id }));
    try {
      await vi.waitFor(() => clients.forEach(([, client]) => expect(client.submit).toHaveBeenCalledTimes(1)));
      expect(clients.reduce((total, [, client]) => total + vi.mocked(client.submit).mock.calls.length, 0)).toBe(5);
    } finally {
      firstWave.resolve();
    }
    await queue.waitForIdle();

    expect(jobs.every((job) => queue.store.require(job.id).status === "done")).toBe(true);
    clients.forEach(([accountId, client]) => {
      expect(client.submit).toHaveBeenCalledTimes(2);
      expect(accounts.get(accountId).usageCount).toBe(2);
    });
  });

  it("uses one account at a time in sequential mode without opening account windows", async () => {
    settings.set("vidu_account_dispatch_mode", "sequential");
    settings.set("vidu_show_active_browser", "true");
    const first = accounts.create("顺序账号 1", { accountType: "points", defaultQuota: 46 });
    const second = accounts.create("顺序账号 2", { accountType: "points", defaultQuota: 46 });
    const project = projects.create({ name: "单账号顺序项目", folderPath: root });
    const rows = storyboards.replace(project.id, Array.from({ length: 4 }, (_, index) => ({
      index,
      originalText: `顺序镜头 ${index + 1}`,
      subjects: ["小李"],
      prompt: `@小李 顺序镜头 ${index + 1}`,
      duration: 4,
    })));
    settings.set("vidu_default_account_id", first.id);
    const firstResult = deferred<void>();
    let submitted = 0;
    const firstClient = fakeClient({
      submit: vi.fn(async () => ({ taskId: `sequential-${++submitted}`, raw: {} })),
      waitForResult: vi.fn(async (taskId) => {
        if (taskId === "sequential-1") await firstResult.promise;
        return { taskId, phase: "succeeded" as const, providerStatus: "success", progress: 100, resultUrl: `https://files.example/${taskId}.mp4`, error: null, raw: {} };
      }),
    });
    const secondClient = fakeClient();
    const openLogin = vi.fn(async (_account: ViduAccount) => undefined);
    start(new Map([[first.id, firstClient], [second.id, secondClient]]), false, 10, undefined, openLogin);

    const jobs = rows.map((row) => queue.enqueue("video.generate", { storyboardId: row.id }));
    try {
      await vi.waitFor(() => expect(firstClient.submit).toHaveBeenCalledOnce());
      await new Promise((resolve) => setImmediate(resolve));
      expect(firstClient.submit).toHaveBeenCalledOnce();
      expect(secondClient.submit).not.toHaveBeenCalled();
    } finally {
      firstResult.resolve();
    }
    await queue.waitForIdle();

    expect(firstClient.submit).toHaveBeenCalledTimes(4);
    expect(secondClient.submit).not.toHaveBeenCalled();
    expect(openLogin).not.toHaveBeenCalled();
    expect(jobs.every((job) => queue.store.require(job.id).status === "done")).toBe(true);
  });

  it("atomically moves a concurrent sequential batch to the next account after credits run out", async () => {
    settings.set("vidu_account_dispatch_mode", "sequential");
    const first = accounts.create("即将用完账号", { accountType: "points", defaultQuota: 46 });
    const second = accounts.create("接续账号", { accountType: "points", defaultQuota: 46 });
    const project = projects.create({ name: "顺序换号项目", folderPath: root });
    const rows = storyboards.replace(project.id, Array.from({ length: 10 }, (_, index) => ({
      index,
      originalText: `换号镜头 ${index + 1}`,
      subjects: ["小李"],
      prompt: `@小李 换号镜头 ${index + 1}`,
      duration: 4,
    })));
    settings.set("vidu_default_account_id", first.id);
    const exhausted = fakeClient({
      submit: vi.fn(async () => { throw new VideoApiError("rate_limit", "Vidu 积分不足", 429); }),
    });
    let accepted = 0;
    const replacement = fakeClient({
      submit: vi.fn(async () => ({ taskId: `replacement-${++accepted}`, raw: {} })),
    });
    start(new Map([[first.id, exhausted], [second.id, replacement]]), false, 10);

    const jobs = rows.map((row) => queue.enqueue("video.generate", { storyboardId: row.id }));
    await queue.waitForIdle();

    expect(exhausted.submit).toHaveBeenCalledTimes(1);
    expect(replacement.submit).toHaveBeenCalledTimes(10);
    expect(accounts.get(first.id)).toMatchObject({ enabled: true, disabledReason: null });
    expect(jobs.every((job) => queue.store.require(job.id).status === "done")).toBe(true);

    await queue.shutdown();
    const retryProject = projects.create({ name: "重启后积分复检", folderPath: root });
    const retryStoryboard = storyboards.replace(retryProject.id, [{
      index: 0,
      originalText: "充值后重试",
      subjects: ["小李"],
      prompt: "@小李 充值后重试",
      duration: 4,
    }])[0];
    const recovered = fakeClient({
      submit: vi.fn(async () => ({ taskId: "recovered-after-restart", raw: {} })),
    });
    const unused = fakeClient();
    start(new Map([[first.id, recovered], [second.id, unused]]), false, 1);
    const retryJob = queue.enqueue("video.generate", { storyboardId: retryStoryboard.id });
    await queue.waitForIdle();

    expect(recovered.submit).toHaveBeenCalledOnce();
    expect(unused.submit).not.toHaveBeenCalled();
    expect(queue.store.require(retryJob.id)).toMatchObject({ status: "done", output: { accountId: first.id } });
  });

  it("finishes every concurrent job when the only account rejects for insufficient credits", async () => {
    settings.set("vidu_account_dispatch_mode", "sequential");
    const account = accounts.create("唯一积分账号", { accountType: "points", defaultQuota: 46 });
    const project = projects.create({ name: "单账号积分不足", folderPath: root });
    const rows = storyboards.replace(project.id, Array.from({ length: 10 }, (_, index) => ({
      index,
      originalText: `单账号镜头 ${index + 1}`,
      subjects: ["小李"],
      prompt: `@小李 单账号镜头 ${index + 1}`,
      duration: 4,
    })));
    const rejected = fakeClient({
      submit: vi.fn(async () => { throw new VideoApiError("rate_limit", "Vidu 积分不足", 429); }),
    });
    start(rejected, false, 10);

    const jobs = rows.map((row) => queue.enqueue("video.generate", { storyboardId: row.id }));
    await queue.waitForIdle();

    expect(rejected.submit).toHaveBeenCalledOnce();
    expect(jobs.every((job) => queue.store.require(job.id).status === "error")).toBe(true);
    expect(accounts.get(account.id)).toMatchObject({ enabled: true, disabledReason: null });
  });

  it("tries each account once and finishes every concurrent job when all accounts reject credits", async () => {
    settings.set("vidu_account_dispatch_mode", "sequential");
    const first = accounts.create("积分账号 1", { accountType: "points", defaultQuota: 46 });
    const second = accounts.create("积分账号 2", { accountType: "points", defaultQuota: 46 });
    const project = projects.create({ name: "双账号积分不足", folderPath: root });
    const rows = storyboards.replace(project.id, Array.from({ length: 10 }, (_, index) => ({
      index,
      originalText: `双账号镜头 ${index + 1}`,
      subjects: ["小李"],
      prompt: `@小李 双账号镜头 ${index + 1}`,
      duration: 4,
    })));
    const firstRejected = fakeClient({
      submit: vi.fn(async () => { throw new VideoApiError("rate_limit", "Vidu CreditsNotEnough", 429); }),
    });
    const secondRejected = fakeClient({
      submit: vi.fn(async () => { throw new VideoApiError("rate_limit", "Vidu InsufficientCredits", 429); }),
    });
    start(new Map([[first.id, firstRejected], [second.id, secondRejected]]), false, 10);

    const jobs = rows.map((row) => queue.enqueue("video.generate", { storyboardId: row.id }));
    await queue.waitForIdle();

    expect(firstRejected.submit).toHaveBeenCalledOnce();
    expect(secondRejected.submit).toHaveBeenCalledOnce();
    expect(jobs.every((job) => queue.store.require(job.id).status === "error")).toBe(true);
    expect(accounts.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, enabled: true, disabledReason: null }),
      expect.objectContaining({ id: second.id, enabled: true, disabledReason: null }),
    ]));
  });

  it("round-robins point accounts without treating the local estimate as provider exhaustion", async () => {
    const first = accounts.create("限额账号 1", { accountType: "points", defaultQuota: 3 });
    const second = accounts.create("限额账号 2", { accountType: "points", defaultQuota: 46 });
    const project = projects.create({ name: "顺序切换项目", folderPath: root });
    const rows = storyboards.replace(project.id, Array.from({ length: 5 }, (_, index) => ({
      index,
      originalText: `小李顺序镜头 ${index + 1}`,
      subjects: ["小李"],
      prompt: `@小李 顺序镜头 ${index + 1}`,
      duration: 4,
    })));
    settings.set("vidu_default_account_id", first.id);
    database.connection.prepare("UPDATE vidu_accounts SET usage_count=3 WHERE id=?").run(first.id);
    let firstSubmitted = 0;
    let secondSubmitted = 0;
    const firstClient = fakeClient({
      submit: vi.fn(async () => ({ taskId: `first-${++firstSubmitted}`, raw: {} })),
    });
    const secondClient = fakeClient({
      submit: vi.fn(async () => ({ taskId: `second-${++secondSubmitted}`, raw: {} })),
    });
    start(new Map([[first.id, firstClient], [second.id, secondClient]]), false, 1);

    const jobs = rows.map((row) => queue.enqueue("video.generate", { storyboardId: row.id }));
    await queue.waitForIdle();

    expect(firstClient.submit).toHaveBeenCalledTimes(3);
    expect(secondClient.submit).toHaveBeenCalledTimes(2);
    expect(accounts.get(first.id).usageCount).toBe(6);
    expect(accounts.get(second.id).usageCount).toBe(2);
    expect(jobs.every((job) => queue.store.require(job.id).status === "done")).toBe(true);
  });

  it("keeps concurrent explicitly selected tasks bound to the requested account", async () => {
    const requested = accounts.create("显式并发账号");
    const other = accounts.create("不应使用的账号");
    const project = projects.create({ name: "显式并发项目", folderPath: root });
    const rows = storyboards.replace(project.id, [0, 1].map((index) => ({
      index,
      originalText: `小李指定镜头 ${index + 1}`,
      subjects: ["小李"],
      prompt: `@小李 指定镜头 ${index + 1}`,
      duration: 4,
    })));
    const resultsHeld = deferred<void>();
    let submitCount = 0;
    const requestedClient = fakeClient({
      submit: vi.fn(async () => {
        submitCount += 1;
        return { taskId: `vidu-explicit-${submitCount}`, raw: {} };
      }),
      waitForResult: vi.fn(async (taskId) => {
        await resultsHeld.promise;
        return { taskId, phase: "succeeded" as const, providerStatus: "success", progress: 100, resultUrl: `https://files.example/${taskId}.mp4`, error: null, raw: {} };
      }),
    });
    const unusedClient = fakeClient();
    start(new Map([[requested.id, requestedClient], [other.id, unusedClient]]), false, 2);

    const jobs = rows.map((row) => queue.enqueue("video.generate", {
      storyboardId: row.id,
      accountId: requested.id,
    }));
    try {
      await vi.waitFor(() => expect(requestedClient.submit).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setImmediate(resolve));
      expect(requestedClient.submit).toHaveBeenCalledTimes(1);
    } finally {
      resultsHeld.resolve();
    }
    await queue.waitForIdle();

    expect(requestedClient.submit).toHaveBeenCalledTimes(2);
    expect(unusedClient.submit).not.toHaveBeenCalled();
    expect(jobs.map((job) => queue.store.require(job.id))).toEqual([
      expect.objectContaining({ status: "done", output: expect.objectContaining({ accountId: requested.id }) }),
      expect.objectContaining({ status: "done", output: expect.objectContaining({ accountId: requested.id }) }),
    ]);
  });

  it("falls back on a non-peak plan limit without disabling an account as credits exhausted", async () => {
    const { account: first, storyboard } = fixture();
    accounts.update(first.id, { accountType: "points", defaultQuota: 46 });
    const second = accounts.create("非高峰备用账号");
    settings.set("vidu_default_account_id", first.id);
    const rejected = fakeClient({
      submit: vi.fn(async () => { throw new VideoApiError("rate_limit", "NonPeakTaskSubmitLimitExceeded", 429); }),
    });
    const accepted = fakeClient({
      submit: vi.fn(async () => ({ taskId: "vidu-nonpeak-fallback", raw: {} })),
    });
    start(new Map([[first.id, rejected], [second.id, accepted]]));

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(accounts.get(first.id)).toMatchObject({ enabled: true, disabledReason: null });
    expect(accepted.submit).toHaveBeenCalledTimes(1);
    expect(queue.store.require(job.id)).toMatchObject({ status: "done", output: { accountId: second.id } });
  });

  it("keeps an unknown account enabled and falls back to the next logged-in account", async () => {
    const { account, storyboard } = fixture();
    const fallback = accounts.create("未知状态时不应切换");
    const firstClient = fakeClient();
    const unused = fakeClient();
    start(new Map([[account.id, firstClient], [fallback.id, unused]]), false, 1, vi.fn(async (candidate) => (
      candidate.id === account.id
        ? { accountId: account.id, status: "unknown" as const, httpStatus: 503, message: "HTTP 503" }
        : { accountId: fallback.id, status: "logged-in" as const, httpStatus: 200, message: "ok" }
    )));

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({ status: "done", output: { accountId: fallback.id } });
    expect(accounts.get(account.id)).toMatchObject({ enabled: true, disabledReason: null });
    expect(firstClient.submit).not.toHaveBeenCalled();
    expect(unused.submit).toHaveBeenCalledTimes(1);
  });

  it("does not switch accounts after a transient submit network failure", async () => {
    const { account, storyboard } = fixture();
    const fallback = accounts.create("网络异常时不应切换");
    settings.set("vidu_default_account_id", account.id);
    const failed = fakeClient({
      submit: vi.fn(async () => { throw new VideoApiError("network", "connection reset"); }),
    });
    const unused = fakeClient();
    start(new Map([[account.id, failed], [fallback.id, unused]]));

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({ status: "error", error: expect.stringContaining("connection reset") });
    expect(failed.submit).toHaveBeenCalledTimes(1);
    expect(unused.submit).not.toHaveBeenCalled();
    expect(accounts.get(account.id)).toMatchObject({ enabled: true, disabledReason: null });
  });

  it("does not mark an unverified authentication error as login expired", async () => {
    const { account, storyboard } = fixture();
    const client = fakeClient({
      submit: vi.fn(async () => { throw new VideoApiError("authentication", "temporary HTML challenge", 200); }),
    });
    start(client);

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({ status: "error" });
    expect(accounts.get(account.id)).toMatchObject({ enabled: true, disabledReason: null });
  });

  it("temporarily cools a subject-limited account without disabling it and switches to the next account", async () => {
    const { account: first, storyboard } = fixture();
    const second = accounts.create("备用账号", { accountType: "member", defaultQuota: 200 });
    settings.set("vidu_default_account_id", first.id);
    const rejected = fakeClient({
      submit: vi.fn(async () => { throw new VideoApiError("subject_limit", "主体库操作频率超限", 429); }),
    });
    const accepted = fakeClient({
      submit: vi.fn(async () => ({ taskId: "vidu-task-subject-fallback", raw: {} })),
    });
    start(new Map([[first.id, rejected], [second.id, accepted]]));

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(rejected.submit).toHaveBeenCalledTimes(1);
    expect(accepted.submit).toHaveBeenCalledTimes(1);
    expect(accounts.get(first.id)).toMatchObject({
      enabled: true,
      disabledReason: null,
      disabledMessage: null,
    });
    expect(queue.store.require(job.id)).toMatchObject({
      status: "done",
      output: { accountId: second.id, providerTaskId: "vidu-task-subject-fallback" },
    });
  });

  it("keeps a subject-limited explicitly selected account enabled without switching", async () => {
    const { account: first, storyboard } = fixture();
    const second = accounts.create("备用账号", { accountType: "member", defaultQuota: 200 });
    const rejected = fakeClient({
      submit: vi.fn(async () => { throw new VideoApiError("subject_limit", "ACCOUNT_SUBJECT_LIMITED", 429); }),
    });
    const unused = fakeClient();
    start(new Map([[first.id, rejected], [second.id, unused]]));

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id, accountId: first.id });
    await queue.waitForIdle();

    expect(rejected.submit).toHaveBeenCalledTimes(1);
    expect(unused.submit).not.toHaveBeenCalled();
    expect(accounts.get(first.id)).toMatchObject({ enabled: true, disabledReason: null });
    expect(queue.store.require(job.id)).toMatchObject({ status: "error", error: expect.stringContaining("ACCOUNT_SUBJECT_LIMITED") });
  });

  it("reactivates accounts that an older build persisted as subject-limited", async () => {
    const { account, storyboard } = fixture();
    accounts.markSubjectLimited(account.id, "旧版主体限频状态");
    expect(accounts.get(account.id)).toMatchObject({ enabled: false, disabledReason: "subject_limit" });
    const client = fakeClient();
    start(client);

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(accounts.get(account.id)).toMatchObject({ enabled: true, disabledReason: null, disabledMessage: null });
    expect(client.submit).toHaveBeenCalledOnce();
    expect(queue.store.require(job.id)).toMatchObject({ status: "done" });
  });

  it("reactivates accounts that an older build persisted as credits-exhausted", async () => {
    const { account, storyboard } = fixture();
    accounts.update(account.id, { accountType: "points" });
    accounts.markQuotaExhausted(account.id, true, "旧版积分不足状态");
    expect(accounts.get(account.id)).toMatchObject({ enabled: false, disabledReason: "credits_exhausted" });
    const client = fakeClient();
    start(client);

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(accounts.get(account.id)).toMatchObject({ enabled: true, disabledReason: null, disabledMessage: null });
    expect(client.submit).toHaveBeenCalledOnce();
    expect(queue.store.require(job.id)).toMatchObject({ status: "done" });
  });

  it("preserves login-expired accounts across startup and uses a logged-in fallback", async () => {
    const { account: expired, storyboard } = fixture();
    const fallback = accounts.create("登录有效备用账号");
    settings.set("vidu_default_account_id", expired.id);
    accounts.markLoginExpired(expired.id, "登录已失效");
    const expiredClient = fakeClient();
    const fallbackClient = fakeClient({
      submit: vi.fn(async () => ({ taskId: "fallback-after-expired-login", raw: {} })),
    });
    const checkLogin = vi.fn(async (account: ViduAccount): Promise<ViduAccountStatus> => ({
      accountId: account.id,
      status: "logged-in",
      httpStatus: 200,
      message: "ok",
    }));
    start(new Map([[expired.id, expiredClient], [fallback.id, fallbackClient]]), false, 1, checkLogin);

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(accounts.get(expired.id)).toMatchObject({ enabled: false, disabledReason: "login_expired" });
    expect(checkLogin.mock.calls.map(([account]) => account.id)).toEqual([fallback.id]);
    expect(expiredClient.submit).not.toHaveBeenCalled();
    expect(fallbackClient.submit).toHaveBeenCalledOnce();
    expect(queue.store.require(job.id)).toMatchObject({ status: "done", output: { accountId: fallback.id } });
  });

  it("startup recovery queries and downloads an existing task without submitting again", async () => {
    const { account, storyboard } = fixture();
    storyboards.saveVideoProviderTask(storyboard.id, "vidu-startup-recovery", "vidu-browser", account.id);
    const client = fakeClient();
    start(client, true);

    await queue.waitForIdle();

    expect(client.submit).not.toHaveBeenCalled();
    expect(client.waitForResult).toHaveBeenCalledWith("vidu-startup-recovery", expect.any(Object));
    expect(storyboards.get(storyboard.id)).toMatchObject({
      videoTaskId: null,
      videoSubmissionState: "idle",
      videoRecoveryState: "idle",
      videoPath: expect.stringContaining("vidu.mp4"),
    });
  });

  it("finds a persisted task on another logged-in account and repairs its ownership", async () => {
    const { account: original, storyboard } = fixture();
    const actual = accounts.create("实际任务账号");
    storyboards.saveVideoProviderTask(storyboard.id, "vidu-cross-account", "vidu-browser", original.id);
    const originalClient = fakeClient({
      poll: vi.fn(async () => { throw new VideoApiError("not_found", "missing", 404); }),
    });
    const actualClient = fakeClient({
      poll: vi.fn(async (taskId) => ({ taskId, phase: "running" as const, providerStatus: "processing", progress: 30, resultUrl: null, error: null, raw: {} })),
    });
    start(new Map([
      [original.id, originalClient],
      [actual.id, actualClient],
    ]), true);

    await queue.waitForIdle();

    expect(originalClient.waitForResult).not.toHaveBeenCalled();
    expect(actualClient.poll).toHaveBeenCalledWith("vidu-cross-account", expect.any(Object));
    expect(actualClient.waitForResult).toHaveBeenCalledWith("vidu-cross-account", expect.any(Object));
    expect(queue.store.list()[0]).toMatchObject({ status: "done", output: { accountId: actual.id } });
    expect(storyboards.get(storyboard.id)).toMatchObject({ videoAccountId: actual.id, videoTaskId: null });
  });

  it.each([
    ["provider_failed", "failed"],
    ["not_found", "not_found"],
    ["unavailable", "unavailable"],
  ] as const)("persists %s as %s with correct recovery ownership", async (kind, recoveryState) => {
    const { account, storyboard } = fixture();
    storyboards.saveVideoProviderTask(storyboard.id, `vidu-${kind}`, "vidu-browser", account.id);
    const client = fakeClient({
      waitForResult: vi.fn(async () => { throw new VideoApiError(kind, `failure:${kind}`); }),
    });
    start(client);

    const job = queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(queue.store.require(job.id)).toMatchObject({ status: "error" });
    expect(storyboards.get(storyboard.id)).toMatchObject({
      videoTaskId: kind === "provider_failed" ? null : `vidu-${kind}`,
      videoSubmissionState: kind === "provider_failed" ? "idle" : "submitted",
      videoRecoveryState: recoveryState,
      videoRecoveryMessage: `failure:${kind}`,
    });
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("persists waiting_url after a completed task times out before its URL appears", async () => {
    const { account, storyboard } = fixture();
    storyboards.saveVideoProviderTask(storyboard.id, "vidu-waiting-url", "vidu-browser", account.id);
    const client = fakeClient({
      waitForResult: vi.fn(async (_taskId, options) => {
        options?.onProgress?.({
          taskId: "vidu-waiting-url",
          phase: "succeeded",
          providerStatus: "success",
          progress: 100,
          resultUrl: null,
          error: null,
          raw: {},
        });
        throw new VideoApiError("timeout", "download URL timeout");
      }),
    });
    start(client);

    queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(storyboards.get(storyboard.id)).toMatchObject({
      videoTaskId: "vidu-waiting-url",
      videoRecoveryState: "waiting_url",
      videoRecoveryMessage: "download URL timeout",
    });
  });

  it("persists download_failed and keeps the task ID for retry", async () => {
    const { account, storyboard } = fixture();
    storyboards.saveVideoProviderTask(storyboard.id, "vidu-download-failed", "vidu-browser", account.id);
    const client = fakeClient({
      downloadResult: vi.fn(async () => { throw new VideoApiError("download", "download failed"); }),
    });
    start(client);

    queue.enqueue("video.generate", { storyboardId: storyboard.id });
    await queue.waitForIdle();

    expect(storyboards.get(storyboard.id)).toMatchObject({
      videoTaskId: "vidu-download-failed",
      videoRecoveryState: "download_failed",
      videoRecoveryMessage: "download failed",
    });
    expect(client.submit).not.toHaveBeenCalled();
  });
});
