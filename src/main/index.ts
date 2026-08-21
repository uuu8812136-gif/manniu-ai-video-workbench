import { join } from "node:path";
import { app, BrowserWindow, dialog, protocol, safeStorage, session, shell } from "electron";
import { is } from "@electron-toolkit/utils";
import { AppDatabase } from "./database";
import { registerIpcHandlers } from "./ipc";
import { DESKTOP_JOB_CONCURRENCY, JobStore, PersistentJobQueue } from "./jobs";
import {
  CharacterProfileRepository,
  ProjectRepository,
  SettingsRepository,
  StoryboardRepository,
  ViduAccountRepository,
  ViduMaterialCacheRepository,
} from "./repositories";
import { registerWorkflowHandlers } from "./workflow-handlers";
import { ElectronSafeStorageCodec, SecureSettingsService } from "./secure-settings";
import { runDiagnostics } from "./diagnostics";
import { importLegacyDatabase } from "./legacy-import";
import { configureRuntimeUserData, resolveDefaultJianyingDraftPath } from "./runtime-paths";
import { registerVideoWorkflowHandler } from "./video-workflow";
import { installOfflineNetworkTestGuard } from "./offline-network-guard";
import { ViduBrowserManager } from "./vidu-browser";
import { ViduRecoveryWorker } from "./video-recovery";
import {
  applyPendingDirectoryRestore,
  createDirectoryBackup,
  currentEncryptionScopeFingerprint,
  prepareDirectoryRestore,
  readLastRestoreStatus,
  validateDirectoryBackup,
} from "./backup";
import { createLocalMediaProtocolHandler } from "./local-media-protocol";
import { LOCAL_MEDIA_SCHEME } from "../shared/local-media";
import { WebhookNotifier } from "./webhook";
import { createJobNotificationHandler } from "./job-notifications";
import { recoverProjectStoryboardDurations, recoverProjectWorkspaces } from "./project-workspace";
import { activeJobQuitDetail, summarizeActiveJobs } from "./app-lifecycle";

configureRuntimeUserData(app);

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

protocol.registerSchemesAsPrivileged([{
  scheme: LOCAL_MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

let database: AppDatabase | null = null;
let jobQueue: PersistentJobQueue | null = null;
let viduBrowser: ViduBrowserManager | null = null;
let viduRecoveryWorker: ViduRecoveryWorker | null = null;
let quitting = false;

async function restartForRestore(): Promise<void> {
  if (quitting) return;
  quitting = true;
  viduRecoveryWorker?.stop();
  viduRecoveryWorker = null;
  await (jobQueue?.shutdown() ?? Promise.resolve());
  viduBrowser?.dispose();
  viduBrowser = null;
  jobQueue = null;
  database?.close();
  database = null;
  app.relaunch();
  app.exit(0);
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: "#f4f6f8",
    title: "AI工具",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.on("close", (event) => {
    if (quitting) return;
    const active = summarizeActiveJobs(jobQueue?.store.list() ?? []);
    if (active.total === 0) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      title: "退出 AI工具",
      message: "仍有任务没有结束，确认退出？",
      detail: activeJobQuitDetail(active),
      buttons: ["取消", "退出"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice === 1) app.quit();
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  installOfflineNetworkTestGuard({
    session: session.defaultSession,
    defaultLogPath: join(userData, "offline-network-guard.jsonl"),
  });
  const paths = {
    userData,
    database: join(userData, "ai-tool.db"),
    projects: join(userData, "projects"),
    documents: app.getPath("documents"),
    logs: join(userData, "logs"),
    jianyingDrafts: resolveDefaultJianyingDraftPath(process.env, app.getPath("home")),
  };
  await applyPendingDirectoryRestore({ paths }).catch((error) => {
    console.error("Pending restore failed before database startup", error);
  });
  database = new AppDatabase(paths.database);
  const projects = new ProjectRepository(database.connection);
  const storyboards = new StoryboardRepository(database.connection);
  const characterProfiles = new CharacterProfileRepository(database.connection);
  const rawSettings = new SettingsRepository(database.connection);
  const viduAccounts = new ViduAccountRepository(database.connection);
  const viduMaterials = new ViduMaterialCacheRepository(database.connection);
  const workspaceRecovery = recoverProjectWorkspaces(projects, characterProfiles);
  workspaceRecovery.warnings.forEach((warning) => console.warn(`Project workspace recovery: ${warning}`));
  const durationRecovery = await recoverProjectStoryboardDurations(projects, storyboards);
  durationRecovery.warnings.forEach((warning) => console.warn(`Project duration recovery: ${warning}`));
  viduBrowser = new ViduBrowserManager(viduMaterials);
  const settings = new SecureSettingsService(rawSettings, new ElectronSafeStorageCodec(safeStorage));
  const webhook = new WebhookNotifier(settings);
  jobQueue = new PersistentJobQueue(
    new JobStore(database.connection),
    DESKTOP_JOB_CONCURRENCY,
    createJobNotificationHandler({ notifier: webhook, projects, storyboards }),
  );
  protocol.handle(LOCAL_MEDIA_SCHEME, createLocalMediaProtocolHandler(storyboards, jobQueue.store));
  registerWorkflowHandlers(jobQueue, settings, storyboards, {
    projects,
    projectsRoot: paths.projects,
    documentsRoot: paths.documents,
    characterProfiles,
    inferenceResourcesRoot: is.dev ? join(process.cwd(), "vendor") : process.resourcesPath,
    allowLegacyInferenceFastPath:
      !app.isPackaged
      && process.env.AI_TOOL_TEST_INTERACTION_AUDIT === "1"
      && process.env.AI_TOOL_TEST_OPENING_FIXTURE_FAST_PATH === "1",
  });
  registerVideoWorkflowHandler(jobQueue, {
    settings,
    storyboards,
    projects,
    characterProfiles,
    projectsRoot: paths.projects,
    viduAccounts,
    viduBrowser,
  });
  registerIpcHandlers(
    projects,
    storyboards,
    characterProfiles,
    settings,
    paths,
    jobQueue,
    () =>
      runDiagnostics({
        directories: { userData: paths.userData, projects: paths.projects, logs: paths.logs },
        database: database!.connection,
      }),
    (sourcePath, dryRun) => importLegacyDatabase(sourcePath, database!, { dryRun }),
    {
      create: async (destinationRoot) => {
        const result = await createDirectoryBackup({
          destinationRoot,
          database: database!.connection,
          sourcePaths: {
            projects: settings.get("project_base_folder")?.trim() || paths.projects,
            logs: paths.logs,
          },
          includeProjects: true,
          includeLogs: true,
          appVersion: app.getVersion(),
          encryptionScopeFingerprint: currentEncryptionScopeFingerprint(),
        });
        return {
          backupPath: result.backupPath,
          manifestPath: result.manifestPath,
          totalFiles: result.totalFiles,
          totalBytes: result.totalBytes,
          warnings: result.warnings,
          createdAt: result.manifest.createdAt,
          protectedSettingCount: result.manifest.security.protectedSettingCount,
        };
      },
      validate: async (backupPath) => {
        const report = await validateDirectoryBackup(backupPath);
        return {
          backupPath: report.backupPath,
          valid: report.valid,
          errors: report.errors,
          warnings: report.warnings,
          totalFiles: report.manifest.totalFiles,
          totalBytes: report.manifest.totalBytes,
          databaseHealthy: report.database.healthy,
          protectedSettingCount: report.security.protectedSettingCount,
        };
      },
      restore: (backupPath) => prepareDirectoryRestore(backupPath, {
        paths: {
          ...paths,
          projects: settings.get("project_base_folder")?.trim() || paths.projects,
        },
        currentEncryptionScopeFingerprint: currentEncryptionScopeFingerprint(),
      }),
      restoreStatus: () => readLastRestoreStatus(paths.userData),
      restart: () => { void restartForRestore(); },
    },
    { accounts: viduAccounts, browser: viduBrowser },
    webhook,
  );
  jobQueue.start();
  viduRecoveryWorker = new ViduRecoveryWorker(jobQueue, storyboards);
  viduRecoveryWorker.start();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  viduRecoveryWorker?.stop();
  viduRecoveryWorker = null;
  void (jobQueue?.shutdown() ?? Promise.resolve()).finally(() => {
    jobQueue = null;
    viduBrowser?.dispose();
    viduBrowser = null;
    database?.close();
    database = null;
    app.quit();
  });
});
