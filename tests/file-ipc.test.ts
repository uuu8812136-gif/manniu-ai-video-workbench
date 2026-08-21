import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../src/shared/contracts";

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openResult: { canceled: true, filePaths: [] as string[] },
  saveResult: { canceled: true, filePath: undefined as string | undefined },
  openPath: vi.fn(async () => ""),
  showItemInFolder: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: {
    showOpenDialog: vi.fn(async () => electronMock.openResult),
    showSaveDialog: vi.fn(async () => electronMock.saveResult),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electronMock.handlers.set(channel, handler);
    }),
  },
  shell: {
    openPath: electronMock.openPath,
    showItemInFolder: electronMock.showItemInFolder,
  },
}));

import { registerIpcHandlers } from "../src/main/ipc";

const event = { sender: {} };

describe("file and media IPC wiring", () => {
  let root: string;
  let enqueue: ReturnType<typeof vi.fn>;
  let enqueueUniqueStoryboard: ReturnType<typeof vi.fn>;
  let enqueuePriorityStoryboard: ReturnType<typeof vi.fn>;
  let jobsList: ReturnType<typeof vi.fn>;
  let latestStoryboardJobs: ReturnType<typeof vi.fn>;
  let jobEvents: ReturnType<typeof vi.fn>;
  let findBlockingStoryboardJobForAny: ReturnType<typeof vi.fn>;
  let findBlockingStoryboardJob: ReturnType<typeof vi.fn>;
  let cancelJob: ReturnType<typeof vi.fn>;
  let waitForJobIdle: ReturnType<typeof vi.fn>;
  let projectsDelete: ReturnType<typeof vi.fn>;
  let projectsCreate: ReturnType<typeof vi.fn>;
  let projectsUpdate: ReturnType<typeof vi.fn>;
  let storyboardsList: ReturnType<typeof vi.fn>;
  let storyboardsGet: ReturnType<typeof vi.fn>;
  let storyboardsReplace: ReturnType<typeof vi.fn>;
  let storyboardsDelete: ReturnType<typeof vi.fn>;
  let forceStopVideo: ReturnType<typeof vi.fn>;
  let assertNoBlockingVideoTasks: ReturnType<typeof vi.fn>;
  let accountGet: ReturnType<typeof vi.fn>;
  let accountList: ReturnType<typeof vi.fn>;
  let accountCreate: ReturnType<typeof vi.fn>;
  let accountAssertCanDelete: ReturnType<typeof vi.fn>;
  let accountDelete: ReturnType<typeof vi.fn>;
  let clearAccountSession: ReturnType<typeof vi.fn>;
  let closeAccount: ReturnType<typeof vi.fn>;
  let openAccountLogin: ReturnType<typeof vi.fn>;
  let checkAccountLogin: ReturnType<typeof vi.fn>;
  let loginWithJwt: ReturnType<typeof vi.fn>;
  let exportSubjectLibrary: ReturnType<typeof vi.fn>;
  let importSubjectLibrary: ReturnType<typeof vi.fn>;
  let clearSubjectLibrary: ReturnType<typeof vi.fn>;
  let notifierTest: ReturnType<typeof vi.fn>;
  let notifierNotify: ReturnType<typeof vi.fn>;
  let settingsGet: ReturnType<typeof vi.fn>;
  let settingsSet: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ai-tool-ipc-"));
    electronMock.handlers.clear();
    electronMock.openResult = { canceled: true, filePaths: [] };
    electronMock.saveResult = { canceled: true, filePath: undefined };
    electronMock.openPath.mockReset().mockResolvedValue("");
    electronMock.showItemInFolder.mockReset();
    const noop = vi.fn();
    enqueue = vi.fn();
    enqueueUniqueStoryboard = vi.fn();
    enqueuePriorityStoryboard = vi.fn();
    jobsList = vi.fn(() => []);
    latestStoryboardJobs = vi.fn(() => []);
    jobEvents = vi.fn(() => []);
    findBlockingStoryboardJobForAny = vi.fn(() => null);
    findBlockingStoryboardJob = vi.fn(() => null);
    cancelJob = vi.fn();
    waitForJobIdle = vi.fn(async () => undefined);
    projectsDelete = vi.fn();
    projectsCreate = vi.fn((input) => ({ id: 1, ...input }));
    projectsUpdate = vi.fn((id, input) => ({ id, name: "自动目录项目", ...input }));
    storyboardsList = vi.fn(() => []);
    storyboardsGet = vi.fn();
    storyboardsReplace = vi.fn();
    storyboardsDelete = vi.fn();
    forceStopVideo = vi.fn((id) => ({ id, status: "error", videoTaskId: null }));
    assertNoBlockingVideoTasks = vi.fn();
    accountGet = vi.fn();
    accountList = vi.fn(() => []);
    accountCreate = vi.fn((_name, options) => ({
      id: crypto.randomUUID(),
      name: _name,
      sessionKey: crypto.randomUUID(),
      jwtFingerprint: options.jwtFingerprint,
      enabled: true,
      accountType: "points",
      defaultQuota: 46,
      usageCount: 0,
      usageDate: "",
      sortOrder: 0,
      disabledReason: null,
      disabledMessage: null,
      disabledAt: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    }));
    accountAssertCanDelete = vi.fn();
    accountDelete = vi.fn();
    clearAccountSession = vi.fn(async () => undefined);
    closeAccount = vi.fn();
    openAccountLogin = vi.fn(async () => undefined);
    checkAccountLogin = vi.fn(async () => ({ status: "logged-in" }));
    loginWithJwt = vi.fn(async () => ({ status: "logged-in" }));
    exportSubjectLibrary = vi.fn();
    importSubjectLibrary = vi.fn();
    clearSubjectLibrary = vi.fn();
    notifierTest = vi.fn(async () => ({ ok: true, status: 200 }));
    notifierNotify = vi.fn(async () => true);
    settingsGet = vi.fn(() => undefined);
    settingsSet = vi.fn();
    const projects = new Proxy({}, { get: (_target, property) => {
      if (property === "create") return projectsCreate;
      if (property === "update") return projectsUpdate;
      if (property === "delete") return projectsDelete;
      return noop;
    } });
    const storyboards = new Proxy({}, {
      get: (_target, property) => {
        if (property === "list") return storyboardsList;
        if (property === "get") return storyboardsGet;
        if (property === "replace") return storyboardsReplace;
        if (property === "delete") return storyboardsDelete;
        if (property === "forceStopVideo") return forceStopVideo;
        if (property === "assertNoBlockingVideoTasks") return assertNoBlockingVideoTasks;
        return noop;
      },
    });
    const settings = new Proxy({}, { get: (_target, property) => {
      if (property === "get") return settingsGet;
      if (property === "set") return settingsSet;
      return noop;
    } });
    const jobs = {
      store: { list: jobsList, latestStoryboardJobs, events: jobEvents, findBlockingStoryboardJobForAny, findBlockingStoryboardJob },
      enqueue,
      enqueueUniqueStoryboard,
      enqueuePriorityStoryboard,
      pause: noop,
      resume: noop,
      cancel: cancelJob,
      retry: noop,
      waitForJobIdle,
    };
    registerIpcHandlers(
      projects as never,
      storyboards as never,
      new Proxy({}, { get: () => noop }) as never,
      settings as never,
      {
        userData: root,
        database: join(root, "app.db"),
        projects: join(root, "projects"),
        documents: join(root, "documents"),
        logs: join(root, "logs"),
        jianyingDrafts: join(root, "jianying-drafts"),
      },
      jobs as never,
      noop,
      noop,
      { create: noop, validate: noop } as never,
      {
        accounts: {
          get: accountGet,
          assertCanDelete: accountAssertCanDelete,
          delete: accountDelete,
          list: accountList,
          create: accountCreate,
          update: noop,
        },
        browser: {
          clearSession: clearAccountSession,
          closeAccount,
          openLogin: openAccountLogin,
          checkLogin: checkAccountLogin,
          loginWithJwt,
          exportSubjectLibrary,
          importSubjectLibrary,
          clearSubjectLibrary,
        },
      } as never,
      { test: notifierTest, notify: notifierNotify } as never,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads the selected text document through the IPC handler", async () => {
    const sourcePath = join(root, "中文 文稿.txt");
    await writeFile(sourcePath, "\ufeff第一章\n本地内容", "utf8");
    electronMock.openResult = { canceled: false, filePaths: [sourcePath] };

    const result = await electronMock.handlers.get(IPC.filesPickDocument)?.(event) as {
      path: string;
      text: string;
      encoding: string;
    };
    expect(result).toMatchObject({ path: sourcePath, text: "第一章\n本地内容", encoding: "utf-8" });
  });

  it("cancels and waits for an active video job before clearing its provider task", async () => {
    findBlockingStoryboardJob.mockReturnValue({ id: "video-job-1", status: "running" });
    let release!: () => void;
    waitForJobIdle.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));

    const stopping = electronMock.handlers.get(IPC.storyboardsForceStopVideo)?.(event, 41) as Promise<unknown>;
    await Promise.resolve();
    expect(cancelJob).toHaveBeenCalledWith("video-job-1");
    expect(waitForJobIdle).toHaveBeenCalledWith("video-job-1");
    expect(forceStopVideo).not.toHaveBeenCalled();

    release();
    await expect(stopping).resolves.toMatchObject({ id: 41, status: "error", videoTaskId: null });
    expect(forceStopVideo).toHaveBeenCalledWith(41);
    expect(cancelJob.mock.invocationCallOrder[0]).toBeLessThan(waitForJobIdle.mock.invocationCallOrder[0]);
    expect(waitForJobIdle.mock.invocationCallOrder[0]).toBeLessThan(forceStopVideo.mock.invocationCallOrder[0]);
  });

  it("validates and creates a material-backed project atomically", async () => {
    const subtitlePath = join(root, "voice.srt");
    const audioPath = join(root, "voice.mp3");
    await Promise.all([writeFile(subtitlePath, "subtitle"), writeFile(audioPath, "audio")]);

    await electronMock.handlers.get(IPC.projectsCreate)?.(event, {
      mode: "advanced",
      name: "完整项目",
      folderPath: root,
      subtitlePath,
      audioPath,
    });

    expect(projectsCreate).toHaveBeenCalledWith({ name: "完整项目", folderPath: root, subtitlePath, audioPath });
    expect((await stat(join(root, "资产图"))).isDirectory()).toBe(true);
  });

  it("creates an original-mode project under the configured project root", async () => {
    const subtitlePath = join(root, "original.srt");
    const audioPath = join(root, "original.wav");
    const projectRoot = join(root, "configured-projects");
    await Promise.all([writeFile(subtitlePath, "subtitle"), writeFile(audioPath, "audio")]);
    settingsGet.mockImplementation((key) => key === "project_base_folder" ? projectRoot : undefined);

    await electronMock.handlers.get(IPC.projectsCreate)?.(event, {
      mode: "original",
      name: "原版项目",
      subtitlePath,
      audioPath,
    });

    const expectedPath = join(projectRoot, "原版项目");
    expect(projectsCreate).toHaveBeenCalledWith({ name: "原版项目", subtitlePath, audioPath });
    expect(projectsUpdate).toHaveBeenCalledWith(1, { folderPath: expectedPath });
    expect((await stat(expectedPath)).isDirectory()).toBe(true);
    expect((await stat(join(expectedPath, "资产图"))).isDirectory()).toBe(true);
  });

  it("enforces original-mode materials, configured root and fixed directory selection", async () => {
    expect(() => electronMock.handlers.get(IPC.projectsCreate)?.(event, {
      mode: "original",
      name: "缺素材",
    })).toThrow("原版模式必须选择字幕文件");

    const subtitlePath = join(root, "required.srt");
    const audioPath = join(root, "required.mp3");
    await Promise.all([writeFile(subtitlePath, "subtitle"), writeFile(audioPath, "audio")]);
    expect(() => electronMock.handlers.get(IPC.projectsCreate)?.(event, {
      mode: "original",
      name: "缺根目录",
      subtitlePath,
      audioPath,
    })).toThrow("原版模式需要先在设置中配置项目根目录");

    settingsGet.mockReturnValue(join(root, "configured"));
    expect(() => electronMock.handlers.get(IPC.projectsCreate)?.(event, {
      mode: "original",
      name: "伪造目录",
      folderPath: root,
      subtitlePath,
      audioPath,
    })).toThrow("原版模式使用设置中的项目根目录");
    expect(projectsCreate).not.toHaveBeenCalled();
  });

  it("creates a default project directory when no custom directory is selected", async () => {
    await electronMock.handlers.get(IPC.projectsCreate)?.(event, { name: "自动目录项目" });

    const expectedPath = join(root, "projects", "自动目录项目");
    expect(projectsCreate).toHaveBeenCalledWith({ name: "自动目录项目" });
    expect(projectsUpdate).toHaveBeenCalledWith(1, { folderPath: expectedPath });
    expect((await stat(expectedPath)).isDirectory()).toBe(true);
    expect((await stat(join(expectedPath, "资产图"))).isDirectory()).toBe(true);
  });

  it("initializes the asset directory when changing a project folder", async () => {
    const changedPath = join(root, "changed-project");

    await electronMock.handlers.get(IPC.projectsUpdate)?.(event, 7, { folderPath: changedPath });

    expect(projectsUpdate).toHaveBeenCalledWith(7, { folderPath: changedPath });
    expect((await stat(join(changedPath, "资产图"))).isDirectory()).toBe(true);
  });

  it("rejects a project with only one of subtitle and audio selected", async () => {
    expect(() => electronMock.handlers.get(IPC.projectsCreate)?.(event, {
      name: "不完整项目",
      subtitlePath: join(root, "voice.srt"),
    })).toThrow("字幕文件和旁白音频必须同时选择");
    expect(projectsCreate).not.toHaveBeenCalled();
  });

  it("tests and dispatches configured notifications through main process IPC", async () => {
    const url = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test";
    await expect(electronMock.handlers.get(IPC.notificationsTest)?.(event, url)).resolves.toEqual({ ok: true, status: 200 });
    await expect(electronMock.handlers.get(IPC.notificationsNotify)?.(event, "batch", "队列完成")).resolves.toBe(true);
    expect(notifierTest).toHaveBeenCalledWith(url);
    expect(notifierNotify).toHaveBeenCalledWith("batch", "队列完成");
  });

  it("reads multiple TXT documents and returns an empty list when selection is cancelled", async () => {
    const firstPath = join(root, "第一篇.txt");
    const secondPath = join(root, "第二篇.txt");
    await Promise.all([
      writeFile(firstPath, "第一篇正文", "utf8"),
      writeFile(secondPath, "第二篇正文", "utf8"),
    ]);
    electronMock.openResult = { canceled: false, filePaths: [firstPath, secondPath] };

    const selected = await electronMock.handlers.get(IPC.filesPickDocuments)?.(event, {
      multiple: true,
      txtOnly: true,
    }) as Array<{ path: string; format: string; text: string }>;
    expect(selected).toMatchObject([
      { path: firstPath, format: "txt", text: "第一篇正文" },
      { path: secondPath, format: "txt", text: "第二篇正文" },
    ]);

    electronMock.openResult = { canceled: true, filePaths: [] };
    await expect(electronMock.handlers.get(IPC.filesPickDocuments)?.(event, {
      multiple: true,
      txtOnly: true,
    })).resolves.toEqual([]);
  });

  it("imports dropped TXT/DOCX documents without a silent 50-file limit", async () => {
    const sourcePath = join(root, "拖入文案.txt");
    const unsupportedPath = join(root, "拖入文案.md");
    await Promise.all([
      writeFile(sourcePath, "拖拽正文", "utf8"),
      writeFile(unsupportedPath, "不支持", "utf8"),
    ]);

    await expect(electronMock.handlers.get(IPC.filesImportDroppedDocuments)?.(event, [sourcePath])).resolves.toMatchObject([
      { path: sourcePath, format: "txt", text: "拖拽正文" },
    ]);
    await expect(electronMock.handlers.get(IPC.filesImportDroppedDocuments)?.(event, [unsupportedPath]))
      .rejects.toThrow("不支持的文档格式");
    await expect(electronMock.handlers.get(IPC.filesImportDroppedDocuments)?.(event, Array.from({ length: 51 }, () => sourcePath)))
      .resolves.toHaveLength(51);
  });

  it("writes a named TXT result inside the selected output directory", async () => {
    const directory = join(root, "捋文输出");
    const result = await electronMock.handlers.get(IPC.filesWriteText)?.(event, {
      directory,
      defaultName: "故事_捋文.txt",
      text: "处理结果",
    });

    expect(result).toBe(join(directory, "故事_捋文.txt"));
    expect(await readFile(result as string, "utf8")).toBe("处理结果");
  });

  it("writes CSV selected by the save dialog with an Excel-compatible BOM", async () => {
    const targetPath = join(root, "分镜 导出.csv");
    electronMock.saveResult = { canceled: false, filePath: targetPath };
    const result = await electronMock.handlers.get(IPC.filesExportCsv)?.(event, {
      defaultName: "分镜.csv",
      columns: ["原文", "提示词"],
      rows: [{ 原文: "第一幕", 提示词: "雨夜" }],
    });
    expect(result).toBe(targetPath);
    expect(await readFile(targetPath, "utf8")).toContain("\ufeff原文,提示词");
  });

  it("atomically copies an imported CSV into the project directory without damaging the source", async () => {
    const sourceDirectory = join(root, "外部");
    const projectDirectory = join(root, "项目");
    const sourcePath = join(sourceDirectory, "分镜表.csv");
    await Promise.all([
      mkdir(sourceDirectory, { recursive: true }),
      mkdir(projectDirectory, { recursive: true }),
    ]);
    await writeFile(sourcePath, "原文,提示词\n第一幕,雨夜", "utf8");
    await writeFile(join(projectDirectory, "分镜表.csv"), "旧内容", "utf8");

    const copied = await electronMock.handlers.get(IPC.filesCopyIntoDirectory)?.(event, {
      sourcePath,
      directory: projectDirectory,
    }) as string;
    expect(copied).toBe(join(projectDirectory, "分镜表.csv"));
    expect(await readFile(copied, "utf8")).toContain("第一幕,雨夜");
    expect(await readFile(sourcePath, "utf8")).toContain("第一幕,雨夜");
    await expect(electronMock.handlers.get(IPC.filesCopyIntoDirectory)?.(event, {
      sourcePath,
      directory: join(root, "不存在"),
    })).rejects.toThrow();
  });

  it("returns structured errors for missing FFmpeg tools", async () => {
    const missing = `missing-tool-${Date.now()}.exe`;
    const result = await electronMock.handlers.get(IPC.mediaHealth)?.(event, {
      ffmpegPath: missing,
      ffprobePath: missing,
    }) as { ok: boolean; ffmpeg: { error: string | null }; ffprobe: { error: string | null } };
    expect(result.ok).toBe(false);
    expect(result.ffmpeg.error).toContain("无法启动");
    expect(result.ffprobe.error).toContain("无法启动");
  });

  it("routes image and video enqueue requests through storyboard deduplication", async () => {
    const existing = { id: "existing-job", status: "paused" };
    enqueueUniqueStoryboard.mockReturnValue(existing);
    const handler = electronMock.handlers.get(IPC.jobsEnqueue)!;

    expect(await handler(event, "image.generate", { storyboardId: 9 })).toBe(existing);
    expect(await handler(event, "video.generate", { storyboardId: 9 })).toBe(existing);
    expect(enqueueUniqueStoryboard).toHaveBeenNthCalledWith(1, "image.generate", { storyboardId: 9 });
    expect(enqueueUniqueStoryboard).toHaveBeenNthCalledWith(2, "video.generate", { storyboardId: 9 });

    await handler(event, "text.polish", { text: "本地文本" });
    expect(enqueue).toHaveBeenCalledWith("text.polish", { text: "本地文本" });
  });

  it("routes priority media work through the front-of-queue API", () => {
    const priority = { id: "priority-job" };
    enqueuePriorityStoryboard.mockReturnValue(priority);
    const handler = electronMock.handlers.get(IPC.jobsEnqueuePriority)!;

    expect(handler(event, "video.generate", { storyboardId: 9 })).toBe(priority);
    expect(enqueuePriorityStoryboard).toHaveBeenCalledWith("video.generate", { storyboardId: 9 });
  });

  it("routes bounded project task and event reads through validated IPC", () => {
    const jobId = "63ec415b-7704-4a99-90c5-c9087a796f46";

    expect(electronMock.handlers.get(IPC.jobsLatestForStoryboards)!(event, [9, 10])).toEqual([]);
    expect(latestStoryboardJobs).toHaveBeenCalledWith([9, 10]);
    expect(electronMock.handlers.get(IPC.jobsEvents)!(event, jobId, 50)).toEqual([]);
    expect(jobEvents).toHaveBeenCalledWith(jobId, 50);
    expect(() => electronMock.handlers.get(IPC.jobsEvents)!(event, jobId, 201)).toThrow();
  });

  it("blocks destructive storyboard operations while generation work is non-terminal", () => {
    storyboardsList.mockReturnValue([{ id: 21 }, { id: 22 }]);
    findBlockingStoryboardJobForAny.mockReturnValue({
      id: "blocking-job",
      type: "video.generate",
      status: "paused",
    });

    const deleteProject = electronMock.handlers.get(IPC.projectsDelete)!;
    const replaceStoryboards = electronMock.handlers.get(IPC.storyboardsReplace)!;
    const deleteStoryboard = electronMock.handlers.get(IPC.storyboardsDelete)!;

    expect(() => deleteProject(event, 3)).toThrow(/Cannot delete project.*blocking-job.*paused/);
    expect(() => replaceStoryboards(event, 3, [])).toThrow(/Cannot replace storyboards.*blocking-job.*paused/);
    expect(() => deleteStoryboard(event, 21)).toThrow(/Cannot delete storyboard.*blocking-job.*paused/);

    expect(findBlockingStoryboardJobForAny).toHaveBeenNthCalledWith(1, [21, 22]);
    expect(findBlockingStoryboardJobForAny).toHaveBeenNthCalledWith(2, [21, 22]);
    expect(findBlockingStoryboardJobForAny).toHaveBeenNthCalledWith(3, [21]);
    expect(projectsDelete).not.toHaveBeenCalled();
    expect(storyboardsReplace).not.toHaveBeenCalled();
    expect(storyboardsDelete).not.toHaveBeenCalled();
  });

  it("allows destructive storyboard operations when no generation work is blocking", async () => {
    storyboardsList.mockReturnValue([{ id: 31 }]);
    projectsDelete.mockReturnValue("project-deleted");
    storyboardsReplace.mockReturnValue(["replacement"]);
    storyboardsDelete.mockReturnValue("storyboard-deleted");

    expect(await electronMock.handlers.get(IPC.projectsDelete)!(event, 4)).toBe("project-deleted");
    expect(await electronMock.handlers.get(IPC.storyboardsReplace)!(event, 4, [])).toEqual(["replacement"]);
    expect(await electronMock.handlers.get(IPC.storyboardsDelete)!(event, 31)).toBe("storyboard-deleted");
    expect(projectsDelete).toHaveBeenCalledWith(4);
    expect(assertNoBlockingVideoTasks).toHaveBeenCalledWith([31], "delete project", { allowUncertain: true });
    expect(storyboardsReplace).toHaveBeenCalledWith(4, []);
    expect(storyboardsDelete).toHaveBeenCalledWith(31);
  });

  it("blocks destructive mutations before consulting the in-memory job queue when a remote task is persisted", () => {
    storyboardsList.mockReturnValue([{ id: 41 }, { id: 42 }]);
    assertNoBlockingVideoTasks.mockImplementation((_ids, action) => {
      throw new Error(`Cannot ${action} while storyboard 41 has persisted video task remote-41`);
    });

    expect(() => electronMock.handlers.get(IPC.projectsDelete)!(event, 5)).toThrow(/persisted video task remote-41/);
    expect(() => electronMock.handlers.get(IPC.storyboardsReplace)!(event, 5, [])).toThrow(/persisted video task remote-41/);
    expect(() => electronMock.handlers.get(IPC.storyboardsDelete)!(event, 41)).toThrow(/persisted video task remote-41/);

    expect(findBlockingStoryboardJobForAny).not.toHaveBeenCalled();
    expect(projectsDelete).not.toHaveBeenCalled();
    expect(storyboardsReplace).not.toHaveBeenCalled();
    expect(storyboardsDelete).not.toHaveBeenCalled();
  });

  it("checks account task ownership before clearing its persistent browser session", async () => {
    const account = {
      id: "63ec415b-7704-4a99-90c5-c9087a796f46",
      name: "Vidu account",
      sessionKey: "6f9c49c7-f833-4af1-a605-bc7706a1b18e",
      enabled: true,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    accountGet.mockReturnValue(account);
    accountAssertCanDelete.mockImplementation(() => {
      throw new Error("该账号仍有未完成或待确认的视频任务，不能删除");
    });

    await expect(electronMock.handlers.get(IPC.viduAccountsDelete)!(event, account.id)).rejects.toThrow(
      /仍有未完成或待确认的视频任务/,
    );
    expect(accountAssertCanDelete).toHaveBeenCalledWith(account.id);
    expect(clearAccountSession).not.toHaveBeenCalled();
    expect(closeAccount).not.toHaveBeenCalled();
    expect(accountDelete).not.toHaveBeenCalled();
  });

  it("keeps the persistent Vidu session during ordinary account operations", async () => {
    const account = {
      id: "63ec415b-7704-4a99-90c5-c9087a796f46",
      name: "Vidu account",
      sessionKey: "6f9c49c7-f833-4af1-a605-bc7706a1b18e",
    };
    accountGet.mockReturnValue(account);
    exportSubjectLibrary.mockResolvedValue({
      version: 1,
      copiedAt: "2026-07-27T00:00:00.000Z",
      sourceAccountName: account.name,
      subjects: [],
    });
    clearSubjectLibrary.mockResolvedValue({ total: 0, success: 0, failed: 0, results: [] });

    await expect(electronMock.handlers.get(IPC.viduAccountsOpenLogin)!(event, account.id)).resolves.toBeUndefined();
    await expect(electronMock.handlers.get(IPC.viduAccountsCheck)!(event, account.id)).resolves.toMatchObject({ status: "logged-in" });
    await expect(electronMock.handlers.get(IPC.viduSubjectsCopy)!(event, account.id)).resolves.toMatchObject({ count: 0 });
    await expect(electronMock.handlers.get(IPC.viduSubjectsClear)!(event, account.id)).resolves.toMatchObject({ total: 0 });

    expect(openAccountLogin).toHaveBeenCalledWith(account);
    expect(checkAccountLogin).toHaveBeenCalledWith(account);
    expect(exportSubjectLibrary).toHaveBeenCalledWith(account);
    expect(clearSubjectLibrary).toHaveBeenCalledWith(account);
    expect(clearAccountSession).not.toHaveBeenCalled();
    expect(closeAccount).not.toHaveBeenCalled();
    expect(accountDelete).not.toHaveBeenCalled();
  });

  it("clears only the selected Vidu account session when deleting that account", async () => {
    const target = {
      id: "63ec415b-7704-4a99-90c5-c9087a796f46",
      name: "Target account",
      sessionKey: "6f9c49c7-f833-4af1-a605-bc7706a1b18e",
    };
    const other = {
      id: "71ad9e7f-90d1-4c95-8701-55f8e03604a3",
      name: "Other account",
      sessionKey: "28fc90ea-ce18-4564-8f80-f71d2603a640",
    };
    accountList.mockReturnValue([target, other]);
    accountGet.mockImplementation((id) => id === target.id ? target : other);
    settingsGet.mockImplementation((key) => key === "vidu_default_account_id" ? target.id : undefined);

    await expect(electronMock.handlers.get(IPC.viduAccountsDelete)!(event, target.id)).resolves.toBeUndefined();

    expect(accountAssertCanDelete).toHaveBeenCalledOnce();
    expect(accountAssertCanDelete).toHaveBeenCalledWith(target.id);
    expect(clearAccountSession).toHaveBeenCalledOnce();
    expect(clearAccountSession).toHaveBeenCalledWith(target);
    expect(clearAccountSession).not.toHaveBeenCalledWith(other);
    expect(closeAccount).toHaveBeenCalledOnce();
    expect(closeAccount).toHaveBeenCalledWith(target.id);
    expect(accountDelete).toHaveBeenCalledOnce();
    expect(accountDelete).toHaveBeenCalledWith(target.id);
    expect(settingsSet).toHaveBeenCalledWith("vidu_default_account_id", "");
  });

  it("keeps a different Vidu default account when deleting an account", async () => {
    const target = {
      id: "63ec415b-7704-4a99-90c5-c9087a796f46",
      name: "Target account",
      sessionKey: "6f9c49c7-f833-4af1-a605-bc7706a1b18e",
    };
    const otherId = "71ad9e7f-90d1-4c95-8701-55f8e03604a3";
    accountGet.mockReturnValue(target);
    settingsGet.mockImplementation((key) => key === "vidu_default_account_id" ? otherId : undefined);

    await expect(electronMock.handlers.get(IPC.viduAccountsDelete)!(event, target.id)).resolves.toBeUndefined();

    expect(accountDelete).toHaveBeenCalledWith(target.id);
    expect(settingsSet).not.toHaveBeenCalledWith("vidu_default_account_id", "");
  });

  it("locks account-pool edits but permits deleting an unrelated exhausted account while generation is active", async () => {
    const accountId = "63ec415b-7704-4a99-90c5-c9087a796f46";
    accountGet.mockReturnValue({
      id: accountId,
      name: "Exhausted account",
      sessionKey: "6f9c49c7-f833-4af1-a605-bc7706a1b18e",
    });
    jobsList.mockReturnValue([{
      id: "media-lock",
      type: "image.standalone",
      status: "running",
    }]);

    expect(() => electronMock.handlers.get(IPC.viduAccountsCreate)!(event, {
      name: "积分账号",
      accountType: "points",
      defaultQuota: 46,
    })).toThrow(/图片或视频生成任务 media-lock.*不能添加账号/);
    expect(() => electronMock.handlers.get(IPC.viduAccountsUpdate)!(event, accountId, { name: "新名称" }))
      .toThrow(/不能修改/);
    expect(() => electronMock.handlers.get(IPC.viduAccountsMove)!(event, accountId, "up"))
      .toThrow(/不能调整账号顺序/);
    expect(() => electronMock.handlers.get(IPC.viduAccountsResetDailyUsage)!(event))
      .toThrow(/不能重置账号用量/);
    await expect(electronMock.handlers.get(IPC.viduAccountsDelete)!(event, accountId)).resolves.toBeUndefined();
    await expect(electronMock.handlers.get(IPC.viduAccountsOpenLogin)!(event, accountId))
      .rejects.toThrow(/不能打开账号登录页/);
    expect(() => electronMock.handlers.get(IPC.viduAccountsCheck)!(event, accountId))
      .toThrow(/不能检测账号登录状态/);

    expect(accountGet).toHaveBeenCalledOnce();
    expect(clearAccountSession).toHaveBeenCalledOnce();
    expect(accountDelete).toHaveBeenCalledWith(accountId);
  });

  it("imports Vidu JWT accounts serially, deduplicates lines, and redacts failed tokens", async () => {
    const makeJwt = (subject: string): string => {
      const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
      return `${encode({ alg: "HS256" })}.${encode({ exp: Math.floor(Date.now() / 1_000) + 3_600, sub: subject })}.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG`;
    };
    const first = makeJwt("first");
    const rejected = makeJwt("rejected");
    loginWithJwt.mockImplementation(async (_account, token) => {
      if (token === rejected) throw new Error(`provider rejected ${token}`);
      return { status: "logged-in" };
    });

    const result = await electronMock.handlers.get(IPC.viduAccountsImportJwt)!(event, {
      tokens: `${first}\n${first}\n${rejected}`,
      ssuid: "shared-ssuid",
    }) as { total: number; success: number; failed: number; results: Array<{ status: string; message: string }> };

    expect(result).toMatchObject({ total: 3, success: 1, failed: 2 });
    expect(result.results.map(({ status }) => status)).toEqual(["success", "failed", "failed"]);
    expect(result.results[1].message).toContain("本次导入");
    expect(JSON.stringify(result)).not.toContain(first);
    expect(JSON.stringify(result)).not.toContain(rejected);
    expect(loginWithJwt).toHaveBeenCalledTimes(2);
    expect(loginWithJwt).toHaveBeenNthCalledWith(1, expect.any(Object), first, "shared-ssuid");
    expect(accountDelete).toHaveBeenCalledTimes(1);
    expect(clearAccountSession).toHaveBeenCalledTimes(1);
    expect(closeAccount).toHaveBeenCalledTimes(1);
  });

  it("persists a sanitized Vidu subject clipboard and passes it to another isolated account", async () => {
    const sourceId = "63ec415b-7704-4a99-90c5-c9087a796f46";
    const targetId = "71ad9e7f-90d1-4c95-8701-55f8e03604a3";
    accountGet.mockImplementation((id) => ({
      id,
      name: id === sourceId ? "来源账号" : "目标账号",
      sessionKey: crypto.randomUUID(),
    }));
    exportSubjectLibrary.mockResolvedValue({
      version: 1,
      copiedAt: "2026-07-27T00:00:00.000Z",
      sourceAccountName: "来源账号",
      subjects: [{
        name: "角色甲",
        labels: [{ style: "国漫", api_key: "must-not-persist" }],
        voice: { id: "voice-1", jwt: "must-not-persist" },
        modality: "image",
        components: [{
          type: "main",
          contentType: "image",
          selectedRegion: {},
          contentUrl: "https://cdn.example.com/content.jpg",
          sourceImageUrl: "https://cdn.example.com/source.jpg",
        }],
      }],
    });
    importSubjectLibrary.mockResolvedValue({
      total: 1,
      success: 1,
      failed: 0,
      results: [{ name: "角色甲", status: "success", message: "主体已创建" }],
    });

    await expect(electronMock.handlers.get(IPC.viduSubjectsCopy)!(event, sourceId)).resolves.toEqual({
      count: 1,
      copiedAt: "2026-07-27T00:00:00.000Z",
      sourceAccountName: "来源账号",
    });
    await expect(electronMock.handlers.get(IPC.viduSubjectsClipboardStatus)!(event)).resolves.toMatchObject({ count: 1, sourceAccountName: "来源账号" });
    await expect(electronMock.handlers.get(IPC.viduSubjectsPaste)!(event, targetId)).resolves.toMatchObject({ total: 1, success: 1, failed: 0 });

    const persisted = await readFile(join(root, "vidu-subject-clipboard.json"), "utf8");
    expect(persisted).not.toMatch(/must-not-persist|api_key|jwt/u);
    expect(importSubjectLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ id: targetId }),
      expect.objectContaining({ subjects: [expect.objectContaining({ name: "角色甲", voice: { id: "voice-1" } })] }),
    );
  });

  it("returns the actual per-item result when clearing a Vidu subject library", async () => {
    const accountId = "63ec415b-7704-4a99-90c5-c9087a796f46";
    accountGet.mockReturnValue({ id: accountId, name: "待清空账号", sessionKey: crypto.randomUUID() });
    clearSubjectLibrary.mockResolvedValue({
      total: 2,
      success: 1,
      failed: 1,
      results: [
        { name: "已删", status: "success", message: "主体已删除" },
        { name: "失败", status: "failed", message: "provider rejected" },
      ],
    });

    await expect(electronMock.handlers.get(IPC.viduSubjectsClear)!(event, accountId)).resolves.toMatchObject({
      total: 2,
      success: 1,
      failed: 1,
    });
    expect(clearSubjectLibrary).toHaveBeenCalledWith(expect.objectContaining({ id: accountId }));
  });

  it("keeps legacy import and all file handlers registered together", () => {
    expect([...electronMock.handlers.keys()]).toEqual(expect.arrayContaining([
      IPC.legacyImportSelect,
      IPC.legacyImportPreview,
      IPC.legacyImportRun,
      IPC.filesPickDocument,
      IPC.filesPickDocuments,
      IPC.filesImportDroppedDocuments,
      IPC.filesPickCsv,
      IPC.filesCopyIntoDirectory,
      IPC.filesPickFile,
      IPC.filesPickDirectory,
      IPC.filesExportText,
      IPC.filesWriteText,
      IPC.filesOpenPath,
      IPC.filesExportCsv,
      IPC.notificationsTest,
      IPC.notificationsNotify,
      IPC.mediaHealth,
      IPC.mediaOpen,
      IPC.mediaReveal,
      IPC.jianyingExport,
    ]));
  });

  it("opens and reveals only media files resolved from a storyboard selector", async () => {
    const videoPath = join(root, "绑定 视频.mp4");
    const imagePath = join(root, "绑定 图片.png");
    await writeFile(videoPath, "video");
    await writeFile(imagePath, "image");
    storyboardsGet.mockReturnValue({ videoPath, imagePaths: [imagePath] });

    await electronMock.handlers.get(IPC.mediaOpen)!(event, { storyboardId: 7, kind: "video" });
    expect(storyboardsGet).toHaveBeenCalledWith(7);
    expect(electronMock.openPath).toHaveBeenCalledWith(videoPath);

    await electronMock.handlers.get(IPC.mediaReveal)!(event, { storyboardId: 7, kind: "image", index: 0 });
    expect(electronMock.showItemInFolder).toHaveBeenCalledWith(imagePath);
  });

  it("rejects unbound, missing, and malformed media selectors before invoking the system shell", async () => {
    const missingPath = join(root, "不存在.mp4");
    storyboardsGet.mockReturnValue({ videoPath: missingPath, imagePaths: [] });
    await expect(electronMock.handlers.get(IPC.mediaOpen)!(event, { storyboardId: 7, kind: "video" }))
      .rejects.toThrow("媒体文件不存在、不可读取或未绑定到该分镜");
    expect(electronMock.openPath).not.toHaveBeenCalled();

    await expect(electronMock.handlers.get(IPC.mediaReveal)!(event, {
      storyboardId: 7,
      kind: "video",
      index: 0,
    })).rejects.toThrow();
    expect(electronMock.showItemInFolder).not.toHaveBeenCalled();
  });
});
