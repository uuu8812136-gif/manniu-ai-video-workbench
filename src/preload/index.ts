import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC, type OfflineApi } from "../shared/contracts";

type InteractionAuditCall = {
  at: string;
  channel: string;
  args: unknown[];
  status: "pending" | "fulfilled" | "rejected";
  error?: string;
};

const interactionAuditEnabled = process.env.AI_TOOL_TEST_INTERACTION_AUDIT === "1";
const interactionAuditCalls: InteractionAuditCall[] = [];

function auditValue(value: unknown): unknown {
  if (typeof value === "string" && /^sk-/iu.test(value.trim())) return "[API_KEY_REDACTED]";
  if (Array.isArray(value)) return value.map(auditValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /(?:apiKey|api_key|jwt|token|sessionKey)/iu.test(key) && typeof item === "string" && item
        ? `[${key.toUpperCase()}_REDACTED]`
        : auditValue(item),
    ]));
  }
  return value;
}

// Match Electron's invoke return type so the strongly typed public API remains unchanged.
async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  if (!interactionAuditEnabled) return ipcRenderer.invoke(channel, ...args);
  const call: InteractionAuditCall = {
    at: new Date().toISOString(),
    channel,
    args: auditValue(args) as unknown[],
    status: "pending",
  };
  interactionAuditCalls.push(call);
  try {
    const result = await ipcRenderer.invoke(channel, ...args);
    call.status = "fulfilled";
    return result;
  } catch (error) {
    call.status = "rejected";
    call.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

const api: OfflineApi = {
  app: {
    paths: () => invoke(IPC.appPaths),
  },
  projects: {
    list: () => invoke(IPC.projectsList),
    create: (input) => invoke(IPC.projectsCreate, input),
    update: (id, input) => invoke(IPC.projectsUpdate, id, input),
    delete: (id) => invoke(IPC.projectsDelete, id),
  },
  characterProfiles: {
    list: (projectId) => invoke(IPC.characterProfilesList, projectId),
    replace: (projectId, profiles) => invoke(IPC.characterProfilesReplace, projectId, profiles),
    update: (id, input) => invoke(IPC.characterProfilesUpdate, id, input),
    delete: (id) => invoke(IPC.characterProfilesDelete, id),
  },
  storyboards: {
    list: (projectId) => invoke(IPC.storyboardsList, projectId),
    replace: (projectId, drafts) => invoke(IPC.storyboardsReplace, projectId, drafts),
    create: (projectId, draft) => invoke(IPC.storyboardsCreate, projectId, draft),
    delete: (id) => invoke(IPC.storyboardsDelete, id),
    update: (id, input) => invoke(IPC.storyboardsUpdate, id, input),
    resetProject: (projectId) => invoke(IPC.storyboardsResetProject, projectId),
    forceStopVideo: (id) => invoke(IPC.storyboardsForceStopVideo, id),
    events: (id, limit) => invoke(IPC.storyboardsEvents, id, limit),
    appendEvent: (id, input) => invoke(IPC.storyboardsAppendEvent, id, input),
  },
  settings: {
    list: () => invoke(IPC.settingsList),
    status: () => invoke(IPC.settingsStatus),
    get: (key) => invoke(IPC.settingsGet, key),
    set: (key, value) => invoke(IPC.settingsSet, key, value),
  },
  notifications: {
    test: (url) => invoke(IPC.notificationsTest, url),
    notify: (event, content) => invoke(IPC.notificationsNotify, event, content),
  },
  jobs: {
    enqueue: (type, input) => invoke(IPC.jobsEnqueue, type, input),
    enqueuePriority: (type, input) => invoke(IPC.jobsEnqueuePriority, type, input),
    list: (status) => invoke(IPC.jobsList, status),
    latestForStoryboards: (storyboardIds) => invoke(IPC.jobsLatestForStoryboards, storyboardIds),
    events: (id, limit) => invoke(IPC.jobsEvents, id, limit),
    pause: (id) => invoke(IPC.jobsPause, id),
    resume: (id) => invoke(IPC.jobsResume, id),
    cancel: (id) => invoke(IPC.jobsCancel, id),
    retry: (id) => invoke(IPC.jobsRetry, id),
  },
  diagnostics: {
    run: () => invoke(IPC.diagnosticsRun),
  },
  legacyImport: {
    selectSource: () => invoke(IPC.legacyImportSelect),
    preview: (sourcePath) => invoke(IPC.legacyImportPreview, sourcePath),
    run: (sourcePath) => invoke(IPC.legacyImportRun, sourcePath),
  },
  files: {
    pickDocument: () => invoke(IPC.filesPickDocument),
    pickDocuments: (input) => invoke(IPC.filesPickDocuments, input),
    importDroppedDocuments: (files) => invoke(
      IPC.filesImportDroppedDocuments,
      files.map((file) => webUtils.getPathForFile(file as File)),
    ),
    fetchQqNovel: (url) => invoke(IPC.filesFetchQqNovel, url),
    pickCsv: () => invoke(IPC.filesPickCsv),
    copyIntoDirectory: (input) => invoke(IPC.filesCopyIntoDirectory, input),
    readSubtitle: (projectId) => invoke(IPC.filesReadSubtitle, projectId),
    pickFile: (kind) => invoke(IPC.filesPickFile, kind),
    pickDirectory: (title) => invoke(IPC.filesPickDirectory, title),
    exportText: (input) => invoke(IPC.filesExportText, input),
    writeText: (input) => invoke(IPC.filesWriteText, input),
    openPath: (path) => invoke(IPC.filesOpenPath, path),
    exportCsv: (input) => invoke(IPC.filesExportCsv, input),
  },
  media: {
    health: (input) => invoke(IPC.mediaHealth, input),
    open: (input) => invoke(IPC.mediaOpen, input),
    reveal: (input) => invoke(IPC.mediaReveal, input),
  },
  jianying: {
    export: (input) => invoke(IPC.jianyingExport, input),
  },
  models: {
    probe: (prefix) => invoke(IPC.modelsProbe, prefix),
  },
  vidu: {
    listAccounts: () => invoke(IPC.viduAccountsList),
    createAccount: (input) => invoke(IPC.viduAccountsCreate, input),
    updateAccount: (id, input) => invoke(IPC.viduAccountsUpdate, id, input),
    deleteAccount: (id) => invoke(IPC.viduAccountsDelete, id),
    openLogin: (id) => invoke(IPC.viduAccountsOpenLogin, id),
    checkAccount: (id) => invoke(IPC.viduAccountsCheck, id),
    moveAccount: (id, direction) => invoke(IPC.viduAccountsMove, id, direction),
    resetDailyUsage: () => invoke(IPC.viduAccountsResetDailyUsage),
    importJwtAccounts: (input) => invoke(IPC.viduAccountsImportJwt, input),
    subjectClipboardStatus: () => invoke(IPC.viduSubjectsClipboardStatus),
    copySubjectLibrary: (id) => invoke(IPC.viduSubjectsCopy, id),
    pasteSubjectLibrary: (id) => invoke(IPC.viduSubjectsPaste, id),
    clearSubjectLibrary: (id) => invoke(IPC.viduSubjectsClear, id),
    resolveUncertain: (storyboardId, input) => invoke(IPC.viduSubmissionResolve, storyboardId, input),
    checkSubmission: (storyboardId) => invoke(IPC.viduSubmissionCheck, storyboardId),
  },
  backup: {
    create: () => invoke(IPC.backupCreate),
    validate: () => invoke(IPC.backupValidate),
    restore: () => invoke(IPC.backupRestore),
    restoreStatus: () => invoke(IPC.backupRestoreStatus),
  },
};

contextBridge.exposeInMainWorld("offline", api);

if (interactionAuditEnabled) {
  contextBridge.exposeInMainWorld("__AI_TOOL_INTERACTION_AUDIT__", {
    clear: () => { interactionAuditCalls.length = 0; },
    snapshot: () => interactionAuditCalls.map((call) => ({ ...call, args: auditValue(call.args) })),
  });
}
