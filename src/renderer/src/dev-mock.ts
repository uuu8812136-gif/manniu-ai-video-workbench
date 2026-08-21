import type {
  LegacyImportReport,
  OfflineApi,
  Project,
  Storyboard,
  StoryboardDraft,
  StoryboardEvent,
  ViduAccount,
  WorkflowJob,
} from "../../shared/contracts";

const now = (): string => new Date().toISOString();
let projectSequence = 2;
let storyboardSequence = 3;
let storyboardEventSequence = 1;
const projects: Project[] = [
  {
    id: 1,
    name: "示例短片",
    folderPath: "D:\\AI工具项目\\project-1",
    csvPath: "",
    rosterPath: "",
    subtitlePath: "",
    audioPath: "",
    createdAt: now(),
    updatedAt: now(),
  },
];
const storyboardMap = new Map<number, Storyboard[]>([
  [
    1,
    [
      {
        id: 1,
        projectId: 1,
        index: 0,
        originalText: "雨夜，最后一班列车缓缓进站。",
        subjects: ["女孩", "列车"],
        prompt: "电影感雨夜车站，女孩撑伞望向驶来的列车，冷暖对比光",
        duration: 4,
        status: "done",
        taskId: null,
        videoTaskId: null,
        videoProvider: "custom-api",
        videoAccountId: null,
        videoSubmissionState: "idle",
        videoRecoveryState: "idle",
        videoRecoveryMessage: null,
        videoPath: null,
        imagePaths: ["D:\\AI工具项目\\project-1\\images\\storyboard-1.png"],
        submitCount: 1,
        updatedAt: now(),
      },
      {
        id: 2,
        projectId: 1,
        index: 1,
        originalText: "车门打开，她看见多年未见的人。",
        subjects: ["女孩", "旅人"],
        prompt: "列车门打开，两人在站台重逢，中景，细腻表情，电影灯光",
        duration: 5,
        status: "pending",
        taskId: null,
        videoTaskId: null,
        videoProvider: "custom-api",
        videoAccountId: null,
        videoSubmissionState: "idle",
        videoRecoveryState: "idle",
        videoRecoveryMessage: null,
        videoPath: null,
        imagePaths: [],
        submitCount: 0,
        updatedAt: now(),
      },
    ],
  ],
]);
const settings: Record<string, string> = {};
const jobs: WorkflowJob[] = [];
const viduAccounts: ViduAccount[] = [];
const storyboardEvents: StoryboardEvent[] = [];

function completeMockImageJob(job: WorkflowJob): void {
  window.setTimeout(() => {
    if (job.status !== "running" && job.status !== "queued") return;
    job.progress = 72;
    job.updatedAt = now();
  }, 350);
  window.setTimeout(() => {
    if (job.status !== "running" && job.status !== "queued") return;
    const input = job.input as { storyboardId: number; count?: number };
    const storyboard = storyboardById(input.storyboardId);
    const count = Math.min(10, Math.max(1, Math.round(input.count ?? 1)));
    storyboard.imagePaths = Array.from(
      { length: count },
      (_, index) => `D:\\AI工具项目\\project-${storyboard.projectId}\\images\\mock-${job.id}-${index + 1}.png`,
    );
    storyboard.taskId = null;
    storyboard.status = "done";
    storyboard.updatedAt = now();
    job.status = "done";
    job.progress = 100;
    job.output = { imagePath: storyboard.imagePaths[0], imagePaths: [...storyboard.imagePaths] };
    job.updatedAt = now();
  }, 850);
}

function completeMockStandaloneImageJob(job: WorkflowJob): void {
  window.setTimeout(() => {
    if (job.status !== "running" && job.status !== "queued") return;
    job.progress = 72;
    job.updatedAt = now();
  }, 350);
  window.setTimeout(() => {
    if (job.status !== "running" && job.status !== "queued") return;
    const input = job.input as { count?: number; outputDirectory?: string; batchName: string };
    const count = Math.min(10, Math.max(1, Math.round(input.count ?? 1)));
    const outputDirectory = `${input.outputDirectory || "D:\\AI工具项目\\independent-images"}\\${input.batchName}`;
    const imagePaths = Array.from(
      { length: count },
      (_, index) => `${outputDirectory}\\mock-${job.id}-${index + 1}.png`,
    );
    job.status = "done";
    job.progress = 100;
    job.output = { imagePath: imagePaths[0], imagePaths, outputDirectory, provider: "openai" };
    job.updatedAt = now();
  }, 850);
}

function projectById(id: number): Project {
  const project = projects.find((item) => item.id === id);
  if (!project) throw new Error(`项目不存在: ${id}`);
  return project;
}

function storyboardById(id: number): Storyboard {
  for (const storyboards of storyboardMap.values()) {
    const storyboard = storyboards.find((item) => item.id === id);
    if (storyboard) return storyboard;
  }
  throw new Error(`分镜不存在: ${id}`);
}

function fromDraft(projectId: number, draft: StoryboardDraft, index: number): Storyboard {
  return {
    id: storyboardSequence++,
    projectId,
    index,
    originalText: draft.originalText,
    subjects: draft.subjects ?? [],
    prompt: draft.prompt ?? "",
    duration: draft.duration ?? 4,
    status: "pending",
    taskId: null,
    videoTaskId: null,
    videoProvider: "custom-api",
    videoAccountId: null,
    videoSubmissionState: "idle",
    videoRecoveryState: "idle",
    videoRecoveryMessage: null,
    videoPath: null,
    imagePaths: [],
    submitCount: 0,
    updatedAt: now(),
  };
}

type DevelopmentMockApi = OfflineApi & { __aiToolDevelopmentMock?: true };

export function installDevelopmentMock(): void {
  const current = window.offline as DevelopmentMockApi | undefined;
  if (current && current.__aiToolDevelopmentMock !== true) return;
  const api: DevelopmentMockApi = {
    app: { paths: async () => ({ userData: "D:\\AI工具数据", database: "D:\\AI工具数据\\ai-tool.db", projects: "D:\\AI工具项目", documents: "C:\\Users\\demo\\Documents", logs: "D:\\AI工具数据\\logs", jianyingDrafts: "C:\\Users\\demo\\AppData\\Local\\JianyingPro\\User Data\\Projects\\com.lveditor.draft" }) },
    projects: {
      list: async () => [...projects],
      create: async (input) => {
        const timestamp = now();
        const project: Project = {
          id: projectSequence++,
          name: input.name,
          folderPath: input.folderPath ?? "",
          csvPath: input.csvPath ?? "",
          rosterPath: input.rosterPath ?? "",
          subtitlePath: input.subtitlePath ?? "",
          audioPath: input.audioPath ?? "",
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        projects.unshift(project);
        storyboardMap.set(project.id, []);
        return project;
      },
      update: async (id, input) => Object.assign(projectById(id), input, { updatedAt: now() }),
      delete: async (id) => { const index = projects.findIndex((item) => item.id === id); if (index >= 0) projects.splice(index, 1); },
    },
    characterProfiles: {
      list: async () => [],
      replace: async () => [],
      update: async () => { throw new Error("开发预览没有角色档案"); },
      delete: async () => undefined,
    },
    storyboards: {
      list: async (projectId) => [...(storyboardMap.get(projectId) ?? [])],
      replace: async (projectId, drafts) => { const values = drafts.map((draft, index) => fromDraft(projectId, draft, index)); storyboardMap.set(projectId, values); return values; },
      create: async (projectId, draft) => { const values = storyboardMap.get(projectId) ?? []; const value = fromDraft(projectId, draft, values.length); values.push(value); storyboardMap.set(projectId, values); return value; },
      delete: async (id) => { for (const values of storyboardMap.values()) { const index = values.findIndex((item) => item.id === id); if (index >= 0) values.splice(index, 1); values.forEach((item, itemIndex) => { item.index = itemIndex; }); } },
      update: async (id, input) => Object.assign(storyboardById(id), input, { updatedAt: now() }),
      resetProject: async (projectId) => {
        const values = storyboardMap.get(projectId) ?? [];
        const storyboardIds = new Set(values.map(({ id }) => id));
        let jobsRemoved = 0;
        for (let index = jobs.length - 1; index >= 0; index -= 1) {
          const input = jobs[index].input as { storyboardId?: unknown } | null;
          if ((jobs[index].type === "image.generate" || jobs[index].type === "video.generate")
            && typeof input?.storyboardId === "number" && storyboardIds.has(input.storyboardId)) {
            jobs.splice(index, 1);
            jobsRemoved += 1;
          }
        }
        values.forEach((storyboard) => Object.assign(storyboard, {
          status: "pending" as const,
          taskId: null,
          videoTaskId: null,
          videoAccountId: null,
          videoSubmissionState: "idle" as const,
          videoRecoveryState: "idle" as const,
          videoRecoveryMessage: null,
          videoPath: null,
          imagePaths: [],
          submitCount: 0,
          updatedAt: now(),
        }));
        return { storyboardsReset: values.length, jobsRemoved };
      },
      forceStopVideo: async (id) => Object.assign(storyboardById(id), {
        status: "error" as const,
        videoTaskId: null,
        videoSubmissionState: "idle" as const,
        videoRecoveryState: "failed" as const,
        videoRecoveryMessage: "已手动停止，可重新生成",
        updatedAt: now(),
      }),
      events: async (id, limit = 100) => {
        const storyboard = storyboardById(id);
        return storyboardEvents
          .filter((event) => event.projectId === storyboard.projectId && event.index === storyboard.index)
          .slice(-limit)
          .reverse();
      },
      appendEvent: async (id, input) => {
        const storyboard = storyboardById(id);
        const event: StoryboardEvent = {
          id: storyboardEventSequence++,
          projectId: storyboard.projectId,
          index: storyboard.index,
          eventType: input.eventType,
          message: input.message ?? "",
          detail: input.detail ?? null,
          taskId: input.taskId ?? null,
          browserIndex: input.browserIndex ?? null,
          createdAt: now(),
        };
        storyboardEvents.push(event);
        return event;
      },
    },
    settings: {
      list: async () => ({ ...settings }),
      status: async () => ({ needsReentry: [] }),
      get: async (key) => settings[key] ?? null,
      set: async (key, value) => { settings[key] = value; },
    },
    notifications: {
      test: async () => ({ ok: true, status: 200 }),
      notify: async () => true,
    },
    jobs: {
      enqueue: async (type, input) => {
        const timestamp = now();
        const job: WorkflowJob = { id: crypto.randomUUID(), type, status: "running", progress: 37, input, output: null, error: null, attempts: 1, createdAt: timestamp, updatedAt: timestamp };
        jobs.push(job);
        if (type === "image.generate" && input && typeof input === "object") {
          storyboardById((input as { storyboardId: number }).storyboardId).taskId = job.id;
          completeMockImageJob(job);
        }
        if (type === "image.standalone" && input && typeof input === "object") completeMockStandaloneImageJob(job);
        return job;
      },
      enqueuePriority: async (type, input) => {
        const timestamp = now();
        const job: WorkflowJob = { id: crypto.randomUUID(), type, status: "queued", progress: 0, input, output: null, error: null, attempts: 0, priority: 100, createdAt: timestamp, updatedAt: timestamp };
        jobs.unshift(job);
        return job;
      },
      list: async (status) => jobs.filter((job) => !status || job.status === status),
      latestForStoryboards: async (storyboardIds) => {
        const ids = new Set(storyboardIds);
        const latest = new Map<string, WorkflowJob>();
        for (const job of jobs) {
          if (job.type !== "image.generate" && job.type !== "video.generate") continue;
          const storyboardId = (job.input as { storyboardId?: unknown } | null)?.storyboardId;
          if (typeof storyboardId !== "number" || !ids.has(storyboardId)) continue;
          const key = `${storyboardId}:${job.type}`;
          const current = latest.get(key);
          if (!current || job.updatedAt > current.updatedAt || (job.updatedAt === current.updatedAt && job.id > current.id)) {
            latest.set(key, job);
          }
        }
        return [...latest.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
      },
      events: async () => [],
      pause: async (id) => Object.assign(jobs.find((job) => job.id === id)!, { status: "paused" as const }),
      resume: async (id) => Object.assign(jobs.find((job) => job.id === id)!, { status: "queued" as const }),
      cancel: async (id) => Object.assign(jobs.find((job) => job.id === id)!, { status: "cancelled" as const }),
      retry: async (id) => Object.assign(jobs.find((job) => job.id === id)!, { status: "queued" as const, progress: 0, error: null }),
    },
    diagnostics: { run: async () => ({ status: "ok", generatedAt: now(), runtime: { node: "22.0.0", electron: "43.2.0", chrome: "144", platform: "win32", architecture: "x64", osRelease: "Windows 11" }, directories: [{ name: "userData", path: "D:\\AI工具数据", writable: true, error: null }], sqlite: { healthy: true, result: ["ok"], error: null } }) },
    legacyImport: {
      selectSource: async () => null,
      preview: async (sourcePath) => emptyLegacyReport(sourcePath),
      run: async (sourcePath) => emptyLegacyReport(sourcePath),
    },
    files: {
      pickDocument: async () => null,
      pickDocuments: async () => [],
      importDroppedDocuments: async () => { throw new Error("开发预览不读取拖入的本地文档"); },
      fetchQqNovel: async () => { throw new Error("开发预览不抓取 QQ 阅读页面"); },
      pickCsv: async () => null,
      copyIntoDirectory: async (input) => `${input.directory}\\${input.fileName ?? input.sourcePath.split(/[\\/]/).pop() ?? "import.csv"}`,
      readSubtitle: async () => { throw new Error("开发预览不读取本地字幕"); },
      pickFile: async () => null,
      pickDirectory: async () => null,
      exportText: async () => null,
      writeText: async (input) => `${input.directory}\\${input.defaultName}`,
      openPath: async () => undefined,
      exportCsv: async () => null,
    },
    media: {
      health: async () => ({ ok: true, ffmpeg: { ok: true, executable: "ffmpeg", version: "7.1", error: null, stderr: "" }, ffprobe: { ok: true, executable: "ffprobe", version: "7.1", error: null, stderr: "" } }),
      open: async () => undefined,
      reveal: async () => undefined,
    },
    jianying: { export: async () => { throw new Error("开发预览不写入剪映草稿"); } },
    models: { probe: async (prefix) => ({ ok: true, provider: prefix === "imagegen" && settings.imagegen_provider === "gemini" ? "gemini" : "openai", status: 200, latencyMs: 28, models: [], message: "接口和鉴权可访问" }) },
    vidu: {
      listAccounts: async () => [...viduAccounts],
      createAccount: async (input) => {
        const timestamp = now();
        const account: ViduAccount = {
          id: crypto.randomUUID(),
          name: input.name,
          sessionKey: crypto.randomUUID(),
          jwtFingerprint: null,
          enabled: true,
          accountType: input.accountType ?? "member",
          defaultQuota: input.defaultQuota ?? (input.accountType === "points" ? 46 : 200),
          usageCount: 0,
          usageDate: "",
          sortOrder: viduAccounts.length,
          disabledReason: null,
          disabledMessage: null,
          disabledAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        viduAccounts.push(account);
        return account;
      },
      updateAccount: async (id, input) => Object.assign(
        viduAccounts.find((account) => account.id === id)!,
        input,
        { updatedAt: now() },
      ),
      deleteAccount: async (id) => {
        const index = viduAccounts.findIndex((account) => account.id === id);
        if (index >= 0) viduAccounts.splice(index, 1);
      },
      openLogin: async () => undefined,
      checkAccount: async (id) => ({ accountId: id, status: "logged-in", httpStatus: 200, message: "Vidu 账号已登录" }),
      moveAccount: async (id, direction) => {
        const index = viduAccounts.findIndex((account) => account.id === id);
        const target = direction === "up" ? index - 1 : index + 1;
        if (index >= 0 && target >= 0 && target < viduAccounts.length) {
          [viduAccounts[index], viduAccounts[target]] = [viduAccounts[target], viduAccounts[index]];
          viduAccounts.forEach((account, order) => { account.sortOrder = order; });
        }
        return [...viduAccounts];
      },
      resetDailyUsage: async () => {
        viduAccounts.forEach((account) => {
          if (account.accountType === "member") {
            account.usageCount = 0;
            account.usageDate = "";
          }
        });
        return [...viduAccounts];
      },
      importJwtAccounts: async (input) => {
        const lines = input.tokens.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
        return {
          total: lines.length,
          success: 0,
          failed: lines.length,
          results: lines.map((_value, index) => ({
            lineNumber: index + 1,
            maskedToken: "[JWT_REDACTED]" as const,
            status: "failed" as const,
            message: "开发预览不验证真实 Vidu JWT",
            account: null,
          })),
        };
      },
      subjectClipboardStatus: async () => ({ count: 0, copiedAt: null, sourceAccountName: null }),
      copySubjectLibrary: async () => ({ count: 0, copiedAt: now(), sourceAccountName: "开发预览账号" }),
      pasteSubjectLibrary: async () => ({ total: 0, success: 0, failed: 0, results: [] }),
      clearSubjectLibrary: async () => ({ total: 0, success: 0, failed: 0, results: [] }),
      resolveUncertain: async (storyboardId, input) => Object.assign(storyboardById(storyboardId), {
        videoTaskId: input.taskId ?? null,
        videoSubmissionState: input.taskId ? "submitted" as const : "idle" as const,
        videoRecoveryState: input.taskId ? "processing" as const : "idle" as const,
        videoRecoveryMessage: null,
      }),
      checkSubmission: async (storyboardId) => ({
        storyboard: storyboardById(storyboardId),
        phase: "running" as const,
        providerStatus: "processing",
        progress: 42,
        resultUrl: null,
      }),
    },
    backup: {
      create: async () => null,
      validate: async () => null,
      restore: async () => null,
      restoreStatus: async () => null,
    },
  };
  api.__aiToolDevelopmentMock = true;
  window.offline = api;
}

function emptyLegacyReport(sourcePath: string): LegacyImportReport {
  return { sourcePath, dryRun: true, strategy: "once-per-source-path", markerKey: "preview", alreadyImported: false, scanned: { projects: 0, storyboards: 0, settings: 0 }, wouldImport: { projects: 0, storyboards: 0, settings: 0 }, imported: { projects: 0, storyboards: 0, settings: 0 }, skipped: { orphanStoryboards: 0, sensitiveSettings: 0, existingSettings: 0 }, sensitiveSettingKeys: [], projectIdMap: {}, warnings: [] };
}
