import type { LocalMediaSelector } from "./local-media";

export type { LocalMediaSelector } from "./local-media";

export type Project = {
  id: number;
  name: string;
  folderPath: string;
  csvPath: string;
  rosterPath: string;
  subtitlePath: string;
  audioPath: string;
  createdAt: string;
  updatedAt: string;
};

export type CharacterAssetType = "character" | "scene" | "special-space";

export type CharacterProfile = {
  id: number;
  projectId: number;
  name: string;
  aliases: string[];
  identity: string;
  gender: string;
  age: string;
  appearance: string;
  hair: string;
  clothing: string;
  personality: string;
  visualPrompt: string;
  assetType: CharacterAssetType;
  prompt: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type CharacterProfileInput = {
  name: string;
  aliases?: string[];
  identity?: string;
  gender?: string;
  age?: string;
  appearance?: string;
  hair?: string;
  clothing?: string;
  personality?: string;
  visualPrompt: string;
  assetType?: CharacterAssetType;
  prompt?: string;
};

export type UpdateCharacterProfileInput = Partial<CharacterProfileInput>;

export type StoryboardStatus = "pending" | "generating" | "done" | "error";
export type VideoProvider = "custom-api" | "vidu-browser";
export type VideoSubmissionState = "idle" | "submitting" | "submitted" | "uncertain";
export type VideoRecoveryState = "idle" | "processing" | "waiting_url" | "download_failed" | "failed" | "not_found" | "unavailable";
export type ViduModel = "Q2" | "Q3";
export type ViduLoginStatus = "logged-in" | "logged-out" | "unknown";
export type ViduAccountType = "member" | "points";
export type ViduAccountDisabledReason = "credits_exhausted" | "subject_limit" | "login_expired" | "manual";

export type ViduAccount = {
  id: string;
  name: string;
  sessionKey: string;
  jwtFingerprint: string | null;
  enabled: boolean;
  accountType: ViduAccountType;
  defaultQuota: number;
  usageCount: number;
  usageDate: string;
  sortOrder: number;
  disabledReason: ViduAccountDisabledReason | null;
  disabledMessage: string | null;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ViduAccountStatus = {
  accountId: string;
  status: ViduLoginStatus;
  httpStatus: number | null;
  message: string;
  availableCredits?: number | null;
};

export type ViduJwtImportLineResult = {
  lineNumber: number;
  maskedToken: "[JWT_REDACTED]";
  status: "success" | "failed";
  message: string;
  account: ViduAccount | null;
};

export type ViduJwtImportResult = {
  total: number;
  success: number;
  failed: number;
  results: ViduJwtImportLineResult[];
};

export type ViduSubjectClipboardStatus = {
  count: number;
  copiedAt: string | null;
  sourceAccountName: string | null;
};

export type ViduSubjectOperationItemResult = {
  name: string;
  status: "success" | "failed";
  message: string;
};

export type ViduSubjectOperationResult = {
  total: number;
  success: number;
  failed: number;
  results: ViduSubjectOperationItemResult[];
};

export type Storyboard = {
  id: number;
  projectId: number;
  index: number;
  originalText: string;
  subjects: string[];
  prompt: string;
  duration: number;
  status: StoryboardStatus;
  taskId: string | null;
  videoTaskId: string | null;
  videoProvider: VideoProvider;
  videoAccountId: string | null;
  videoSubmissionState: VideoSubmissionState;
  videoRecoveryState: VideoRecoveryState;
  videoRecoveryMessage: string | null;
  videoPath: string | null;
  imagePaths: string[];
  submitCount: number;
  updatedAt: string;
};

export type StoryboardEvent = {
  id: number;
  projectId: number;
  index: number;
  eventType: string;
  message: string;
  detail: unknown | null;
  taskId: string | null;
  browserIndex: number | null;
  createdAt: string;
};

export type StoryboardEventInput = {
  eventType: string;
  message?: string;
  detail?: unknown;
  taskId?: string | null;
  browserIndex?: number | null;
};

export type CreateProjectInput = {
  mode?: ProjectCreationMode;
  name: string;
  folderPath?: string;
  csvPath?: string;
  rosterPath?: string;
  subtitlePath?: string;
  audioPath?: string;
};

export type ProjectCreationMode = "original" | "advanced";

export type WebhookEvent = "error" | "complete" | "throttle" | "quota" | "batch";

export type UpdateProjectInput = Partial<
  Pick<Project, "name" | "folderPath" | "csvPath" | "rosterPath" | "subtitlePath" | "audioPath">
>;

export type StoryboardDraft = {
  index: number;
  originalText: string;
  subjects?: string[];
  prompt?: string;
  duration?: number;
};

export type UpdateStoryboardInput = Partial<StoryboardDraft> & {
  status?: StoryboardStatus;
  videoPath?: string | null;
  imagePaths?: string[];
};

export type AppPaths = {
  userData: string;
  database: string;
  projects: string;
  documents: string;
  logs: string;
  jianyingDrafts: string;
};

export type WorkflowJobType = "opening.optimize" | "text.polish" | "storyboard.infer" | "image.generate" | "image.standalone" | "video.generate";
export type WorkflowJobStatus = "queued" | "running" | "paused" | "done" | "error" | "cancelled";

export type WorkflowJob = {
  id: string;
  type: WorkflowJobType;
  status: WorkflowJobStatus;
  progress: number;
  input: unknown;
  output: unknown | null;
  error: string | null;
  attempts: number;
  priority?: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowJobEvent = {
  id: number;
  jobId: string;
  level: "debug" | "info" | "warning" | "error";
  message: string;
  detail: unknown | null;
  createdAt: string;
};

export type OpeningJobInput = {
  text: string;
  title?: string;
  mode?: "general" | "enhanced" | "rewrite" | "variants";
  outDir?: string;
};

export type PolishJobInput = {
  text: string;
  title?: string;
  outDir?: string;
  mode?: "original" | "advanced";
  sourceFormat?: "txt" | "docx";
};

export type StoryboardJobInput = {
  text: string;
  genre?: string;
  projectId?: number;
};

export type ImageJobInput = {
  storyboardId: number;
  characterProfileId?: number;
  prompt?: string;
  model?: string;
  count?: number;
  size?: string;
  quality?: string;
  aspectRatio?: string;
  referenceImagePaths?: string[];
};

export type StandaloneImageJobInput = Omit<ImageJobInput, "storyboardId"> & {
  prompt: string;
  name: string;
  batchName: string;
  outputDirectory?: string;
  workbenchKey?: string;
};

export type StandaloneImageJobOutput = {
  imagePath: string;
  imagePaths: string[];
  outputDirectory: string;
  provider: string;
};

export type VideoJobInput = {
  storyboardId: number;
  provider?: VideoProvider;
  accountId?: string;
  viduModel?: ViduModel;
  q3PreCount?: number;
  useCredits?: boolean;
  prompt?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  imageUrl?: string;
  parameters?: Record<string, unknown>;
};

export type BackupSummary = {
  backupPath: string;
  manifestPath: string;
  totalFiles: number;
  totalBytes: number;
  warnings: string[];
  createdAt: string;
  protectedSettingCount: number;
};

export type ProjectResetResult = {
  storyboardsReset: number;
  jobsRemoved: number;
};

export type BackupValidationSummary = {
  backupPath: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  totalFiles: number;
  totalBytes: number;
  databaseHealthy: boolean;
  protectedSettingCount: number;
};

export type BackupRestoreSummary = {
  restoreId: string;
  backupPath: string;
  restartRequired: true;
  requiresSecretReentry: boolean;
  clearedSettingKeys: string[];
  rewrittenPathCount: number;
  warnings: string[];
};

export type BackupRestoreStatus = {
  status: "applied" | "failed";
  restoreId: string;
  completedAt: string;
  message: string;
  rollbackPath: string | null;
  rollbackPaths: string[];
  requiresSecretReentry: boolean;
  clearedSettingKeys: string[];
  warnings: string[];
};

export type ModelProbePrefix = "infer" | "text_polish" | "imagegen";

export type ModelProbeResult = {
  ok: boolean;
  provider: "openai" | "gemini";
  status: number | null;
  latencyMs: number;
  models: string[];
  message: string;
};

export type DiagnosticReport = {
  status: "ok" | "error";
  generatedAt: string;
  runtime: {
    node: string;
    electron: string | null;
    chrome: string | null;
    platform: string;
    architecture: string;
    osRelease: string;
  };
  directories: Array<{ name: string; path: string; writable: boolean; error: string | null }>;
  sqlite: { healthy: boolean; result: string[]; error: string | null };
};

export type LegacyImportCounts = {
  projects: number;
  storyboards: number;
  settings: number;
};

export type LegacyImportReport = {
  sourcePath: string;
  dryRun: boolean;
  strategy: "once-per-source-path";
  markerKey: string;
  alreadyImported: boolean;
  scanned: LegacyImportCounts;
  wouldImport: LegacyImportCounts;
  imported: LegacyImportCounts;
  skipped: {
    orphanStoryboards: number;
    sensitiveSettings: number;
    existingSettings: number;
  };
  sensitiveSettingKeys: string[];
  projectIdMap: Record<string, number>;
  warnings: string[];
};

export type SupportedTextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030";

export type ImportedDocumentFile = {
  path: string;
  format: "txt" | "docx";
  text: string;
  encoding: SupportedTextEncoding;
  hadBom: boolean;
  warnings: string[];
};

export type ImportedNovelSource = {
  url: string;
  title: string;
  text: string;
};

export type CsvIssue = {
  type: string;
  code: string;
  message: string;
  row?: number;
};

export type ImportedCsvFile = {
  path: string;
  columns: string[];
  rows: Array<Record<string, string>>;
  errors: CsvIssue[];
  encoding: SupportedTextEncoding;
};

export type SrtCue = {
  text: string;
  startUs: number;
  endUs: number;
};

export type ImportedSrtFile = {
  path: string;
  cues: SrtCue[];
  encoding: SupportedTextEncoding;
  hadBom: boolean;
  warnings: string[];
};

export type LocalFileKind = "visual" | "audio" | "subtitle" | "executable";

export type MediaToolHealth = {
  ok: boolean;
  executable: string;
  version: string | null;
  error: string | null;
  stderr: string;
};

export type MediaHealth = {
  ok: boolean;
  ffmpeg: MediaToolHealth;
  ffprobe: MediaToolHealth;
};

export type JianyingVisualClip = {
  filePath: string;
  durationUs: number;
  sourceDurationUs?: number;
  startUs?: number;
  width?: number;
  height?: number;
  kind?: "video" | "photo";
};

export type JianyingAudioClip = {
  filePath: string;
  durationUs: number;
  sourceDurationUs?: number;
  startUs?: number;
  volume?: number;
};

export type JianyingSubtitle = {
  text: string;
  startUs: number;
  endUs: number;
};

export type JianyingBlackClip = {
  durationUs: number;
  startUs?: number;
};

export type JianyingExportInput = {
  draftRoot: string;
  projectName: string;
  timelineDurationUs?: number;
  preserveVisualSpeed?: boolean;
  visualClips?: JianyingVisualClip[];
  blackClips?: JianyingBlackClip[];
  audioClips?: JianyingAudioClip[];
  subtitles?: JianyingSubtitle[];
  width?: number;
  height?: number;
  fps?: number;
  copyMaterials?: boolean;
  overwrite?: boolean;
};

export type JianyingValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    tracks: number;
    segments: number;
    materials: number;
    durationUs: number;
  };
};

export type JianyingExportResult = {
  draftPath: string;
  contentPath: string;
  metaPath: string;
  materialPaths: string[];
  durationUs: number;
  validation: JianyingValidationResult;
};

export const IPC = {
  appPaths: "app:paths",
  projectsList: "projects:list",
  projectsCreate: "projects:create",
  projectsUpdate: "projects:update",
  projectsDelete: "projects:delete",
  characterProfilesList: "character-profiles:list",
  characterProfilesReplace: "character-profiles:replace",
  characterProfilesUpdate: "character-profiles:update",
  characterProfilesDelete: "character-profiles:delete",
  storyboardsList: "storyboards:list",
  storyboardsReplace: "storyboards:replace",
  storyboardsCreate: "storyboards:create",
  storyboardsDelete: "storyboards:delete",
  storyboardsUpdate: "storyboards:update",
  storyboardsResetProject: "storyboards:reset-project",
  storyboardsForceStopVideo: "storyboards:force-stop-video",
  storyboardsEvents: "storyboards:events",
  storyboardsAppendEvent: "storyboards:append-event",
  settingsList: "settings:list",
  settingsStatus: "settings:status",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  notificationsTest: "notifications:test",
  notificationsNotify: "notifications:notify",
  jobsEnqueue: "jobs:enqueue",
  jobsEnqueuePriority: "jobs:enqueue-priority",
  jobsList: "jobs:list",
  jobsLatestForStoryboards: "jobs:latest-for-storyboards",
  jobsEvents: "jobs:events",
  jobsPause: "jobs:pause",
  jobsResume: "jobs:resume",
  jobsCancel: "jobs:cancel",
  jobsRetry: "jobs:retry",
  diagnosticsRun: "diagnostics:run",
  legacyImportSelect: "legacy-import:select",
  legacyImportPreview: "legacy-import:preview",
  legacyImportRun: "legacy-import:run",
  filesPickDocument: "files:pick-document",
  filesPickDocuments: "files:pick-documents",
  filesImportDroppedDocuments: "files:import-dropped-documents",
  filesFetchQqNovel: "files:fetch-qq-novel",
  filesPickCsv: "files:pick-csv",
  filesCopyIntoDirectory: "files:copy-into-directory",
  filesReadSubtitle: "files:read-subtitle",
  filesPickFile: "files:pick-file",
  filesPickDirectory: "files:pick-directory",
  filesExportText: "files:export-text",
  filesWriteText: "files:write-text",
  filesOpenPath: "files:open-path",
  filesExportCsv: "files:export-csv",
  mediaHealth: "media:health",
  mediaOpen: "media:open",
  mediaReveal: "media:reveal",
  jianyingExport: "jianying:export",
  modelsProbe: "models:probe",
  backupCreate: "backup:create",
  backupValidate: "backup:validate",
  backupRestore: "backup:restore",
  backupRestoreStatus: "backup:restore-status",
  viduAccountsList: "vidu-accounts:list",
  viduAccountsCreate: "vidu-accounts:create",
  viduAccountsUpdate: "vidu-accounts:update",
  viduAccountsDelete: "vidu-accounts:delete",
  viduAccountsOpenLogin: "vidu-accounts:open-login",
  viduAccountsCheck: "vidu-accounts:check",
  viduAccountsMove: "vidu-accounts:move",
  viduAccountsResetDailyUsage: "vidu-accounts:reset-daily-usage",
  viduAccountsImportJwt: "vidu-accounts:import-jwt",
  viduSubjectsClipboardStatus: "vidu-subjects:clipboard-status",
  viduSubjectsCopy: "vidu-subjects:copy",
  viduSubjectsPaste: "vidu-subjects:paste",
  viduSubjectsClear: "vidu-subjects:clear",
  viduSubmissionResolve: "vidu-submission:resolve",
  viduSubmissionCheck: "vidu-submission:check",
} as const;

export type OfflineApi = {
  app: {
    paths(): Promise<AppPaths>;
  };
  projects: {
    list(): Promise<Project[]>;
    create(input: CreateProjectInput): Promise<Project>;
    update(id: number, input: UpdateProjectInput): Promise<Project>;
    delete(id: number): Promise<void>;
  };
  characterProfiles: {
    list(projectId: number): Promise<CharacterProfile[]>;
    replace(projectId: number, profiles: CharacterProfileInput[]): Promise<CharacterProfile[]>;
    update(id: number, input: UpdateCharacterProfileInput): Promise<CharacterProfile>;
    delete(id: number): Promise<void>;
  };
  storyboards: {
    list(projectId: number): Promise<Storyboard[]>;
    replace(projectId: number, drafts: StoryboardDraft[]): Promise<Storyboard[]>;
    create(projectId: number, draft: StoryboardDraft): Promise<Storyboard>;
    delete(id: number): Promise<void>;
    update(id: number, input: UpdateStoryboardInput): Promise<Storyboard>;
    resetProject(projectId: number): Promise<ProjectResetResult>;
    forceStopVideo(id: number): Promise<Storyboard>;
    events(id: number, limit?: number): Promise<StoryboardEvent[]>;
    appendEvent(id: number, input: StoryboardEventInput): Promise<StoryboardEvent>;
  };
  settings: {
    list(): Promise<Record<string, string>>;
    status(): Promise<{ needsReentry: string[] }>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  notifications: {
    test(url?: string): Promise<{ ok: true; status: number }>;
    notify(event: WebhookEvent, content: string): Promise<boolean>;
  };
  jobs: {
    enqueue(
      type: "opening.optimize",
      input: OpeningJobInput,
    ): Promise<WorkflowJob>;
    enqueue(type: "text.polish", input: PolishJobInput): Promise<WorkflowJob>;
    enqueue(type: "storyboard.infer", input: StoryboardJobInput): Promise<WorkflowJob>;
    enqueue(type: "image.generate", input: ImageJobInput): Promise<WorkflowJob>;
    enqueue(type: "image.standalone", input: StandaloneImageJobInput): Promise<WorkflowJob>;
    enqueue(type: "video.generate", input: VideoJobInput): Promise<WorkflowJob>;
    enqueue(type: WorkflowJobType, input: unknown): Promise<WorkflowJob>;
    enqueuePriority(type: "image.generate", input: ImageJobInput): Promise<WorkflowJob>;
    enqueuePriority(type: "video.generate", input: VideoJobInput): Promise<WorkflowJob>;
    list(status?: WorkflowJobStatus): Promise<WorkflowJob[]>;
    latestForStoryboards(storyboardIds: number[]): Promise<WorkflowJob[]>;
    events(id: string, limit?: number): Promise<WorkflowJobEvent[]>;
    pause(id: string): Promise<WorkflowJob>;
    resume(id: string): Promise<WorkflowJob>;
    cancel(id: string): Promise<WorkflowJob>;
    retry(id: string): Promise<WorkflowJob>;
  };
  diagnostics: {
    run(): Promise<DiagnosticReport>;
  };
  legacyImport: {
    selectSource(): Promise<string | null>;
    preview(sourcePath: string): Promise<LegacyImportReport>;
    run(sourcePath: string): Promise<LegacyImportReport>;
  };
  files: {
    pickDocument(): Promise<ImportedDocumentFile | null>;
    pickDocuments(input?: { multiple?: boolean; txtOnly?: boolean }): Promise<ImportedDocumentFile[]>;
    importDroppedDocuments(files: readonly unknown[]): Promise<ImportedDocumentFile[]>;
    fetchQqNovel(url: string): Promise<ImportedNovelSource>;
    pickCsv(): Promise<ImportedCsvFile | null>;
    copyIntoDirectory(input: { sourcePath: string; directory: string; fileName?: string }): Promise<string>;
    readSubtitle(projectId: number): Promise<ImportedSrtFile>;
    pickFile(kind: LocalFileKind): Promise<string | null>;
    pickDirectory(title?: string): Promise<string | null>;
    exportText(input: { defaultName: string; text: string }): Promise<string | null>;
    writeText(input: { directory: string; defaultName: string; text: string }): Promise<string>;
    openPath(path: string): Promise<void>;
    exportCsv(input: {
      defaultName: string;
      rows: Array<Record<string, string>>;
      columns?: string[];
    }): Promise<string | null>;
  };
  media: {
    health(input?: { ffmpegPath?: string; ffprobePath?: string }): Promise<MediaHealth>;
    open(input: LocalMediaSelector): Promise<void>;
    reveal(input: LocalMediaSelector): Promise<void>;
  };
  jianying: {
    export(input: JianyingExportInput): Promise<JianyingExportResult>;
  };
  models: {
    probe(prefix: ModelProbePrefix): Promise<ModelProbeResult>;
  };
  vidu: {
    listAccounts(): Promise<ViduAccount[]>;
    createAccount(input: { name: string; accountType?: ViduAccountType; defaultQuota?: number }): Promise<ViduAccount>;
    updateAccount(id: string, input: {
      name?: string;
      enabled?: boolean;
      accountType?: ViduAccountType;
      defaultQuota?: number;
      clearDisabled?: boolean;
    }): Promise<ViduAccount>;
    deleteAccount(id: string): Promise<void>;
    openLogin(id: string): Promise<void>;
    checkAccount(id: string): Promise<ViduAccountStatus>;
    moveAccount(id: string, direction: "up" | "down"): Promise<ViduAccount[]>;
    resetDailyUsage(): Promise<ViduAccount[]>;
    importJwtAccounts(input: { tokens: string; ssuid?: string }): Promise<ViduJwtImportResult>;
    subjectClipboardStatus(): Promise<ViduSubjectClipboardStatus>;
    copySubjectLibrary(id: string): Promise<ViduSubjectClipboardStatus>;
    pasteSubjectLibrary(id: string): Promise<ViduSubjectOperationResult>;
    clearSubjectLibrary(id: string): Promise<ViduSubjectOperationResult>;
    resolveUncertain(storyboardId: number, input: { taskId?: string; clear?: boolean }): Promise<Storyboard>;
    checkSubmission(storyboardId: number): Promise<{
      storyboard: Storyboard;
      phase: "queued" | "running" | "succeeded" | "failed";
      providerStatus: string;
      progress: number | null;
      resultUrl: string | null;
    }>;
  };
  backup: {
    create(): Promise<BackupSummary | null>;
    validate(): Promise<BackupValidationSummary | null>;
    restore(): Promise<BackupRestoreSummary | null>;
    restoreStatus(): Promise<BackupRestoreStatus | null>;
  };
};
