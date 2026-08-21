import { basename, dirname, join } from "node:path";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions } from "electron";
import { z } from "zod";
import {
  IPC,
  type AppPaths,
  type BackupRestoreStatus,
  type BackupSummary,
  type BackupValidationSummary,
  type LegacyImportReport,
  type ModelProbePrefix,
  type ViduJwtImportLineResult,
  type WebhookEvent,
  type WorkflowJobStatus,
  type WorkflowJobType,
} from "../shared/contracts";
import { localMediaReference } from "../shared/local-media";
import { PersistentJobQueue } from "./jobs";
import {
  CharacterProfileRepository,
  ProjectRepository,
  SettingsRepository,
  StoryboardRepository,
  ViduAccountRepository,
} from "./repositories";
import type { SecureSettingsService } from "./secure-settings";
import { parseWorkflowInput } from "./workflow-handlers";
import { copyFileIntoDirectory, readCsvFile, readDocument, readSrtFile, writeCsvFileAtomic, writeTextFileAtomic } from "./file-workflows";
import { checkMediaHealth } from "./media";
import { exportJianyingDraft, hydrateJianyingMediaMetadata } from "./jianying";
import { parseApiKeys } from "./api-key-pool";
import { probeModelConnection } from "./model-probe";
import { isSecretSettingKey, SECRET_SETTING_MASK } from "./secure-settings";
import { parseViduSubjectClipboard, type ViduBrowserManager, type ViduSubjectClipboard } from "./vidu-browser";
import { resolveBoundLocalMediaFile } from "./local-media-protocol";
import { fetchQqNovel } from "./novel-source";
import {
  createNamedProjectDirectory,
  initializeProjectWorkspace,
  validateProjectCreationPaths,
  validateProjectMaterialPaths,
} from "./project-creation";
import { resetProjectGeneration } from "./project-reset";
import type { WebhookNotifier } from "./webhook";
import { prepareViduJwtLines, redactViduJwt } from "./vidu-jwt";
import { checkViduSubmissionNow } from "./video-workflow";

const projectInput = z.object({
  mode: z.enum(["original", "advanced"]).optional(),
  name: z.string().trim().min(1).max(160),
  folderPath: z.string().optional(),
  csvPath: z.string().optional(),
  rosterPath: z.string().optional(),
  subtitlePath: z.string().optional(),
  audioPath: z.string().optional(),
}).strict();

const projectUpdate = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    folderPath: z.string().optional(),
    csvPath: z.string().optional(),
    rosterPath: z.string().optional(),
    subtitlePath: z.string().optional(),
    audioPath: z.string().optional(),
  })
  .strict();

const storyboardDraft = z.object({
  index: z.number().int().nonnegative(),
  originalText: z.string(),
  subjects: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  duration: z.number().int().positive().max(600).optional(),
});

const characterProfileInput = z.object({
  name: z.string().trim().min(1).max(240),
  aliases: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
  identity: z.string().max(10_000).optional(),
  gender: z.string().max(240).optional(),
  age: z.string().max(240).optional(),
  appearance: z.string().max(20_000).optional(),
  hair: z.string().max(10_000).optional(),
  clothing: z.string().max(10_000).optional(),
  personality: z.string().max(10_000).optional(),
  visualPrompt: z.string().trim().min(1).max(100_000),
  assetType: z.enum(["character", "scene", "special-space"]).optional(),
  prompt: z.string().max(100_000).optional(),
}).strict();

const databasePath = z.string().trim().min(1).max(32_767);
const localPath = z.string().trim().min(1).max(32_767);
const defaultName = z.string().trim().min(1).max(240);
const csvRecord = z.record(z.string().max(240), z.string().max(1_000_000));
const mediaBinaryInput = z
  .object({
    ffmpegPath: z.string().trim().min(1).max(32_767).optional(),
    ffprobePath: z.string().trim().min(1).max(32_767).optional(),
  })
  .strict()
  .optional();
const localMediaSelector = z.discriminatedUnion("kind", [
  z.object({ storyboardId: z.number().int().positive(), kind: z.literal("video") }).strict(),
  z.object({ storyboardId: z.number().int().positive(), kind: z.literal("image"), index: z.number().int().nonnegative() }).strict(),
]);
const visualClip = z.object({
  filePath: localPath,
  durationUs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sourceDurationUs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  startUs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  width: z.number().int().positive().max(16_384).optional(),
  height: z.number().int().positive().max(16_384).optional(),
  kind: z.enum(["video", "photo"]).optional(),
});
const audioClip = z.object({
  filePath: localPath,
  durationUs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sourceDurationUs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  startUs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  volume: z.number().min(0).max(10).optional(),
});
const subtitle = z.object({
  text: z.string().trim().min(1).max(1_000_000),
  startUs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  endUs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const blackClip = z.object({
  durationUs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  startUs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
const jianyingInput = z
  .object({
    draftRoot: localPath,
    projectName: z.string().trim().min(1).max(160),
    timelineDurationUs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    preserveVisualSpeed: z.boolean().optional(),
    visualClips: z.array(visualClip).max(10_000).optional(),
    blackClips: z.array(blackClip).max(10_000).optional(),
    audioClips: z.array(audioClip).max(10_000).optional(),
    subtitles: z.array(subtitle).max(10_000).optional(),
    width: z.number().int().positive().max(16_384).optional(),
    height: z.number().int().positive().max(16_384).optional(),
    fps: z.number().int().positive().max(240).optional(),
    copyMaterials: z.boolean().optional(),
    overwrite: z.boolean().optional(),
  })
  .strict();
const viduAccountCreate = z.object({
  name: z.string().trim().min(1).max(160),
  accountType: z.enum(["member", "points"]).optional(),
  defaultQuota: z.number().int().min(1).max(500).optional(),
}).strict();
const viduAccountUpdate = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  enabled: z.boolean().optional(),
  accountType: z.enum(["member", "points"]).optional(),
  defaultQuota: z.number().int().min(1).max(500).optional(),
  clearDisabled: z.boolean().optional(),
}).strict();
const viduJwtImport = z.object({
  tokens: z.string().max(2_000_000),
  ssuid: z.string().trim().max(1_024).optional(),
}).strict();

function isObjectWithCode(value: unknown): value is { code: string } {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string";
}

async function showOpenDialog(event: IpcMainInvokeEvent, options: OpenDialogOptions) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
}

async function showSaveDialog(event: IpcMainInvokeEvent, options: SaveDialogOptions) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options);
}

export function registerIpcHandlers(
  projects: ProjectRepository,
  storyboards: StoryboardRepository,
  characterProfiles: CharacterProfileRepository,
  settings: SecureSettingsService,
  paths: AppPaths,
  jobs: PersistentJobQueue,
  diagnostics: () => unknown,
  legacyImport: (sourcePath: string, dryRun: boolean) => LegacyImportReport,
  backup: {
    create(destinationRoot: string): Promise<BackupSummary>;
    validate(backupPath: string): Promise<BackupValidationSummary>;
    restore(backupPath: string): Promise<import("../shared/contracts").BackupRestoreSummary>;
    restoreStatus(): Promise<BackupRestoreStatus | null>;
    restart(): void;
  },
  vidu?: {
    accounts: ViduAccountRepository;
    browser: ViduBrowserManager;
  },
  notifier?: Pick<WebhookNotifier, "test" | "notify">,
): void {
  const viduSubjectClipboardPath = join(paths.userData, "vidu-subject-clipboard.json");
  const readViduSubjectClipboard = async (): Promise<ViduSubjectClipboard | null> => {
    try {
      return parseViduSubjectClipboard(JSON.parse(await readFile(viduSubjectClipboardPath, "utf8")));
    } catch (error) {
      if (isObjectWithCode(error) && error.code === "ENOENT") return null;
      throw error;
    }
  };
  const writeViduSubjectClipboard = async (clipboard: ViduSubjectClipboard): Promise<void> => {
    const temporaryPath = `${viduSubjectClipboardPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(parseViduSubjectClipboard(clipboard))}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, viduSubjectClipboardPath);
  };
  const assertNoBlockingGeneration = (storyboardIds: Iterable<number>, action: string): void => {
    const blocking = jobs.store.findBlockingStoryboardJobForAny(storyboardIds);
    if (blocking) {
      throw new Error(`Cannot ${action} while ${blocking.type} job ${blocking.id} is ${blocking.status}`);
    }
  };

  const assertAccountPoolUnlocked = (action: string): void => {
    const blocking = jobs.store.list().find((job) =>
      (job.type === "image.generate" || job.type === "image.standalone" || job.type === "video.generate")
      && (job.status === "queued" || job.status === "running" || job.status === "paused"),
    );
    if (blocking) {
      throw new Error(`图片或视频生成任务 ${blocking.id} 仍为 ${blocking.status}，账号池已锁定，不能${action}`);
    }
  };

  ipcMain.handle(IPC.appPaths, () => paths);
  ipcMain.handle(IPC.projectsList, () => projects.list());
  ipcMain.handle(IPC.projectsCreate, (_event, input: unknown) => {
    const value = projectInput.parse(input);
    const mode = value.mode ?? "advanced";
    const hasMaterials = Boolean(value.subtitlePath?.trim() || value.audioPath?.trim());
    if (mode === "original") {
      if (!value.subtitlePath?.trim()) throw new Error("原版模式必须选择字幕文件");
      if (!value.audioPath?.trim()) throw new Error("原版模式必须选择音频文件");
      if (value.folderPath?.trim()) throw new Error("原版模式使用设置中的项目根目录，不能自定义项目目录");
      const root = settings.get("project_base_folder")?.trim();
      if (!root) throw new Error("原版模式需要先在设置中配置项目根目录");
      const materials = validateProjectMaterialPaths({
        subtitlePath: value.subtitlePath,
        audioPath: value.audioPath,
      });
      const created = projects.create({
        name: value.name,
        csvPath: value.csvPath,
        rosterPath: value.rosterPath,
        ...materials,
      });
      try {
        return projects.update(created.id, { folderPath: createNamedProjectDirectory(root, created.name) });
      } catch (error) {
        projects.delete(created.id);
        throw error;
      }
    }
    if (hasMaterials && (!value.subtitlePath?.trim() || !value.audioPath?.trim())) {
      throw new Error("字幕文件和旁白音频必须同时选择");
    }
    if (value.folderPath?.trim()) {
      const normalized = hasMaterials
        ? validateProjectCreationPaths({
          folderPath: value.folderPath,
          subtitlePath: value.subtitlePath!,
          audioPath: value.audioPath!,
        })
        : { folderPath: value.folderPath };
      const { mode: _mode, ...project } = value;
      return projects.create({
        ...project,
        ...normalized,
        folderPath: initializeProjectWorkspace(normalized.folderPath),
      });
    }

    const materials = hasMaterials
      ? validateProjectMaterialPaths({ subtitlePath: value.subtitlePath!, audioPath: value.audioPath! })
      : {};
    const created = projects.create({
      name: value.name,
      csvPath: value.csvPath,
      rosterPath: value.rosterPath,
      ...materials,
    });
    const root = settings.get("project_base_folder")?.trim() || paths.projects;
    try {
      return projects.update(created.id, { folderPath: createNamedProjectDirectory(root, created.name) });
    } catch (error) {
      projects.delete(created.id);
      throw error;
    }
  });
  ipcMain.handle(IPC.projectsUpdate, (_event, id: unknown, input: unknown) => {
    const value = projectUpdate.parse(input);
    return projects.update(z.number().int().positive().parse(id), {
      ...value,
      ...(value.folderPath?.trim() ? { folderPath: initializeProjectWorkspace(value.folderPath) } : {}),
    });
  });
  ipcMain.handle(IPC.projectsDelete, (_event, id: unknown) => {
    const projectId = z.number().int().positive().parse(id);
    const storyboardIds = storyboards.list(projectId).map(({ id: storyboardId }) => storyboardId);
    storyboards.assertNoBlockingVideoTasks(storyboardIds, "delete project", { allowUncertain: true });
    assertNoBlockingGeneration(storyboardIds, "delete project");
    return projects.delete(projectId);
  });
  ipcMain.handle(IPC.characterProfilesList, (_event, projectId: unknown) =>
    characterProfiles.list(z.number().int().positive().parse(projectId)),
  );
  ipcMain.handle(IPC.characterProfilesReplace, (_event, projectId: unknown, profiles: unknown) =>
    characterProfiles.replace(
      z.number().int().positive().parse(projectId),
      z.array(characterProfileInput).max(10_000).parse(profiles),
    ),
  );
  ipcMain.handle(IPC.characterProfilesUpdate, (_event, id: unknown, input: unknown) =>
    characterProfiles.update(
      z.number().int().positive().parse(id),
      characterProfileInput.partial().parse(input),
    ),
  );
  ipcMain.handle(IPC.characterProfilesDelete, (_event, id: unknown) =>
    characterProfiles.delete(z.number().int().positive().parse(id)),
  );
  ipcMain.handle(IPC.storyboardsList, (_event, projectId: unknown) =>
    storyboards.list(z.number().int().positive().parse(projectId)),
  );
  ipcMain.handle(IPC.storyboardsReplace, (_event, projectId: unknown, drafts: unknown) => {
    const parsedProjectId = z.number().int().positive().parse(projectId);
    const parsedDrafts = z.array(storyboardDraft).max(10_000).parse(drafts);
    const storyboardIds = storyboards.list(parsedProjectId).map(({ id: storyboardId }) => storyboardId);
    storyboards.assertNoBlockingVideoTasks(storyboardIds, "replace storyboards");
    assertNoBlockingGeneration(storyboardIds, "replace storyboards");
    return storyboards.replace(parsedProjectId, parsedDrafts);
  });
  ipcMain.handle(IPC.storyboardsCreate, (_event, projectId: unknown, draft: unknown) =>
    storyboards.create(
      z.number().int().positive().parse(projectId),
      storyboardDraft.parse(draft),
    ),
  );
  ipcMain.handle(IPC.storyboardsDelete, (_event, id: unknown) => {
    const storyboardId = z.number().int().positive().parse(id);
    storyboards.assertNoBlockingVideoTasks([storyboardId], "delete storyboard");
    assertNoBlockingGeneration([storyboardId], "delete storyboard");
    return storyboards.delete(storyboardId);
  });
  ipcMain.handle(IPC.storyboardsUpdate, (_event, id: unknown, input: unknown) =>
    storyboards.update(
      z.number().int().positive().parse(id),
      storyboardDraft.partial().extend({
        status: z.enum(["pending", "generating", "done", "error"]).optional(),
        videoPath: z.string().max(32_767).nullable().optional(),
        imagePaths: z.array(z.string().max(32_767)).max(100).optional(),
      }).parse(input),
    ),
  );
  ipcMain.handle(IPC.storyboardsResetProject, (_event, projectId: unknown) => {
    const id = z.number().int().positive().parse(projectId);
    projects.get(id);
    const items = storyboards.list(id);
    const storyboardIds = items.map(({ id: storyboardId }) => storyboardId);
    storyboards.assertNoBlockingVideoTasks(storyboardIds, "reset project", { allowUncertain: true });
    assertNoBlockingGeneration(storyboardIds, "reset project");
    return resetProjectGeneration({
      storyboards: items,
      storyboardRepository: storyboards,
      jobStore: jobs.store,
    });
  });
  ipcMain.handle(IPC.storyboardsForceStopVideo, async (_event, id: unknown) => {
    const storyboardId = z.number().int().positive().parse(id);
    const active = jobs.store.findBlockingStoryboardJob("video.generate", storyboardId);
    if (active) {
      jobs.cancel(active.id);
      await jobs.waitForJobIdle(active.id);
    }
    return storyboards.forceStopVideo(storyboardId);
  });
  ipcMain.handle(IPC.storyboardsEvents, (_event, id: unknown, limit: unknown) =>
    storyboards.events(
      z.number().int().positive().parse(id),
      z.number().int().min(1).max(1_000).optional().parse(limit),
    ),
  );
  ipcMain.handle(IPC.storyboardsAppendEvent, (_event, id: unknown, input: unknown) =>
    storyboards.appendEvent(
      z.number().int().positive().parse(id),
      z.object({
        eventType: z.string().trim().min(1).max(120),
        message: z.string().max(4_000).optional(),
        detail: z.unknown().optional(),
        taskId: z.string().trim().max(500).nullable().optional(),
        browserIndex: z.number().int().min(0).max(10_000).nullable().optional(),
      }).strict().parse(input),
    ),
  );
  ipcMain.handle(IPC.settingsList, () => settings.listPublic());
  ipcMain.handle(IPC.settingsStatus, () => settings.status());
  ipcMain.handle(IPC.settingsGet, (_event, key: unknown) => {
    const parsed = z.string().min(1).max(120).parse(key);
    if (isSecretSettingKey(parsed)) return settings.hasSecret(parsed) ? SECRET_SETTING_MASK : null;
    return settings.get(parsed);
  });
  ipcMain.handle(IPC.settingsSet, (_event, key: unknown, value: unknown) =>
    settings.set(z.string().min(1).max(120).parse(key), z.string().max(100_000).parse(value)),
  );
  ipcMain.handle(IPC.notificationsTest, (_event, url: unknown) => {
    if (!notifier) throw new Error("通知服务未初始化");
    const provided = z.string().trim().max(4_096).optional().parse(url);
    const target = !provided || provided === SECRET_SETTING_MASK ? settings.get("webhook_url")?.trim() : provided;
    if (!target) throw new Error("请先填写 Webhook URL");
    return notifier.test(target);
  });
  ipcMain.handle(IPC.notificationsNotify, (_event, event: unknown, content: unknown) => {
    if (!notifier) return false;
    return notifier.notify(
      z.enum(["error", "complete", "throttle", "quota", "batch"]).parse(event) as WebhookEvent,
      z.string().trim().min(1).max(2_000).parse(content),
    );
  });
  ipcMain.handle(IPC.jobsEnqueue, (_event, typeValue: unknown, input: unknown) => {
    const type = z
      .enum(["opening.optimize", "text.polish", "storyboard.infer", "image.generate", "image.standalone", "video.generate"])
      .parse(typeValue) as WorkflowJobType;
    const parsed = parseWorkflowInput(type, input);
    if (type === "image.generate" || type === "video.generate") {
      return jobs.enqueueUniqueStoryboard(type, parsed as { storyboardId: number });
    }
    return jobs.enqueue(type, parsed);
  });
  ipcMain.handle(IPC.jobsEnqueuePriority, (_event, typeValue: unknown, input: unknown) => {
    const type = z.enum(["image.generate", "video.generate"]).parse(typeValue);
    const parsed = parseWorkflowInput(type, input) as { storyboardId: number };
    return jobs.enqueuePriorityStoryboard(type, parsed);
  });
  ipcMain.handle(IPC.jobsList, (_event, statusValue: unknown) => {
    const status = z
      .enum(["queued", "running", "paused", "done", "error", "cancelled"])
      .optional()
      .parse(statusValue) as WorkflowJobStatus | undefined;
    return jobs.store.list(status);
  });
  ipcMain.handle(IPC.jobsLatestForStoryboards, (_event, storyboardIds: unknown) => jobs.store.latestStoryboardJobs(
    z.array(z.number().int().positive()).max(10_000).parse(storyboardIds),
  ));
  ipcMain.handle(IPC.jobsEvents, (_event, id: unknown, limitValue: unknown) => jobs.store.events(
    z.string().uuid().parse(id),
    z.number().int().positive().max(200).optional().parse(limitValue),
  ));
  ipcMain.handle(IPC.jobsPause, (_event, id: unknown) => jobs.pause(z.string().uuid().parse(id)));
  ipcMain.handle(IPC.jobsResume, (_event, id: unknown) => jobs.resume(z.string().uuid().parse(id)));
  ipcMain.handle(IPC.jobsCancel, (_event, id: unknown) => jobs.cancel(z.string().uuid().parse(id)));
  ipcMain.handle(IPC.jobsRetry, (_event, id: unknown) => jobs.retry(z.string().uuid().parse(id)));
  if (vidu) {
    ipcMain.handle(IPC.viduAccountsList, () => vidu.accounts.list());
    ipcMain.handle(IPC.viduAccountsCreate, (_event, input: unknown) => {
      assertAccountPoolUnlocked("添加账号");
      const value = viduAccountCreate.parse(input);
      return vidu.accounts.create(value.name, value);
    });
    ipcMain.handle(IPC.viduAccountsUpdate, (_event, id: unknown, input: unknown) => {
      assertAccountPoolUnlocked("修改账号");
      return vidu.accounts.update(
        z.string().uuid().parse(id),
        viduAccountUpdate.parse(input),
      );
    });
    ipcMain.handle(IPC.viduAccountsMove, (_event, id: unknown, direction: unknown) => {
      assertAccountPoolUnlocked("调整账号顺序");
      return vidu.accounts.move(z.string().uuid().parse(id), z.enum(["up", "down"]).parse(direction));
    });
    ipcMain.handle(IPC.viduAccountsResetDailyUsage, () => {
      assertAccountPoolUnlocked("重置账号用量");
      return vidu.accounts.resetDailyUsage();
    });
    ipcMain.handle(IPC.viduAccountsImportJwt, async (_event, input: unknown) => {
      assertAccountPoolUnlocked("批量导入积分账号");
      const value = viduJwtImport.parse(input);
      const existing = new Set(
        vidu.accounts.list().map((account) => account.jwtFingerprint).filter((fingerprint): fingerprint is string => Boolean(fingerprint)),
      );
      const prepared = prepareViduJwtLines(value.tokens, existing);
      const results: ViduJwtImportLineResult[] = [];
      for (const line of prepared) {
        if (line.status === "failed") {
          results.push({ ...line, account: null });
          continue;
        }
        let account: ReturnType<ViduAccountRepository["create"]> | null = null;
        try {
          account = vidu.accounts.create(`积分-${line.fingerprint.slice(0, 6)}`, {
            accountType: "points",
            defaultQuota: 46,
            jwtFingerprint: line.fingerprint,
          });
          await vidu.browser.loginWithJwt(account, line.jwt, value.ssuid);
          results.push({
            lineNumber: line.lineNumber,
            maskedToken: line.maskedToken,
            status: "success",
            message: "JWT 验证成功，积分账号已导入",
            account,
          });
        } catch (error) {
          if (account) {
            await vidu.browser.clearSession(account).catch(() => undefined);
            vidu.browser.closeAccount(account.id);
            try {
              vidu.accounts.delete(account.id);
            } catch {
              // The account has no task ownership during import; keep the original validation error if cleanup fails.
            }
          }
          results.push({
            lineNumber: line.lineNumber,
            maskedToken: line.maskedToken,
            status: "failed",
            message: redactViduJwt(error instanceof Error ? error.message : String(error)),
            account: null,
          });
        }
      }
      const success = results.filter((result) => result.status === "success").length;
      return { total: results.length, success, failed: results.length - success, results };
    });
    ipcMain.handle(IPC.viduAccountsDelete, async (_event, id: unknown) => {
      const account = vidu.accounts.get(z.string().uuid().parse(id));
      vidu.accounts.assertCanDelete(account.id);
      try {
        await vidu.browser.clearSession(account);
      } finally {
        vidu.browser.closeAccount(account.id);
      }
      vidu.accounts.delete(account.id);
      if (settings.get("vidu_default_account_id")?.trim() === account.id) {
        settings.set("vidu_default_account_id", "");
      }
    });
    ipcMain.handle(IPC.viduAccountsOpenLogin, async (_event, id: unknown) => {
      assertAccountPoolUnlocked("打开账号登录页");
      return vidu.browser.openLogin(vidu.accounts.get(z.string().uuid().parse(id)));
    });
    ipcMain.handle(IPC.viduAccountsCheck, (_event, id: unknown) => {
      assertAccountPoolUnlocked("检测账号登录状态");
      return vidu.browser.checkLogin(vidu.accounts.get(z.string().uuid().parse(id)));
    });
    ipcMain.handle(IPC.viduSubjectsClipboardStatus, async () => {
      const clipboard = await readViduSubjectClipboard();
      return {
        count: clipboard?.subjects.length ?? 0,
        copiedAt: clipboard?.copiedAt ?? null,
        sourceAccountName: clipboard?.sourceAccountName ?? null,
      };
    });
    ipcMain.handle(IPC.viduSubjectsCopy, async (_event, id: unknown) => {
      assertAccountPoolUnlocked("复制账号主体库");
      const clipboard = await vidu.browser.exportSubjectLibrary(vidu.accounts.get(z.string().uuid().parse(id)));
      await writeViduSubjectClipboard(clipboard);
      return {
        count: clipboard.subjects.length,
        copiedAt: clipboard.copiedAt,
        sourceAccountName: clipboard.sourceAccountName,
      };
    });
    ipcMain.handle(IPC.viduSubjectsPaste, async (_event, id: unknown) => {
      assertAccountPoolUnlocked("粘贴账号主体库");
      const clipboard = await readViduSubjectClipboard();
      if (!clipboard || clipboard.subjects.length === 0) throw new Error("本地主体剪贴板为空，请先从一个已登录账号复制主体库");
      return vidu.browser.importSubjectLibrary(vidu.accounts.get(z.string().uuid().parse(id)), clipboard);
    });
    ipcMain.handle(IPC.viduSubjectsClear, async (_event, id: unknown) => {
      assertAccountPoolUnlocked("清空账号主体库");
      return vidu.browser.clearSubjectLibrary(vidu.accounts.get(z.string().uuid().parse(id)));
    });
    ipcMain.handle(IPC.viduSubmissionResolve, (_event, storyboardId: unknown, input: unknown) =>
      storyboards.resolveUncertainVideoSubmission(
        z.number().int().positive().parse(storyboardId),
        z.object({ taskId: z.string().trim().min(1).max(200).optional(), clear: z.boolean().optional() }).strict().parse(input),
      ),
    );
    ipcMain.handle(IPC.viduSubmissionCheck, (_event, storyboardId: unknown) =>
      checkViduSubmissionNow({
        storyboards,
        accounts: vidu.accounts,
        browser: vidu.browser,
        storyboardId: z.number().int().positive().parse(storyboardId),
      }),
    );
  }
  ipcMain.handle(IPC.diagnosticsRun, diagnostics);
  ipcMain.handle(IPC.legacyImportSelect, async (event) => {
    const options: OpenDialogOptions = {
      title: "选择旧版 database.db",
      properties: ["openFile"],
      filters: [
        { name: "SQLite database", extensions: ["db", "sqlite", "sqlite3"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.legacyImportPreview, (_event, sourcePath: unknown) =>
    legacyImport(databasePath.parse(sourcePath), true),
  );
  ipcMain.handle(IPC.legacyImportRun, (_event, sourcePath: unknown) =>
    legacyImport(databasePath.parse(sourcePath), false),
  );
  ipcMain.handle(IPC.filesPickDocument, async (event) => {
    const auditDocumentPath = process.env.AI_TOOL_TEST_DOCUMENT_PATH?.trim();
    if (process.env.AI_TOOL_TEST_INTERACTION_AUDIT === "1" && auditDocumentPath) {
      return readDocument(auditDocumentPath);
    }
    const result = await showOpenDialog(event, {
      title: "选择 TXT 或 DOCX 文档",
      properties: ["openFile"],
      filters: [{ name: "文本文档", extensions: ["txt", "docx"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return readDocument(result.filePaths[0]);
  });
  ipcMain.handle(IPC.filesPickDocuments, async (event, inputValue: unknown) => {
    const input = z.object({ multiple: z.boolean().optional(), txtOnly: z.boolean().optional() }).strict().optional().parse(inputValue);
    const auditDocumentPathsValue = process.env.AI_TOOL_TEST_DOCUMENT_PATHS_JSON?.trim();
    if (process.env.AI_TOOL_TEST_INTERACTION_AUDIT === "1" && auditDocumentPathsValue) {
      const auditDocumentPaths = z.array(localPath).min(1).max(100).parse(JSON.parse(auditDocumentPathsValue));
      return Promise.all(auditDocumentPaths.map((filePath) => readDocument(filePath)));
    }
    const auditDocumentPath = process.env.AI_TOOL_TEST_DOCUMENT_PATH?.trim();
    if (process.env.AI_TOOL_TEST_INTERACTION_AUDIT === "1" && auditDocumentPath) {
      return [await readDocument(auditDocumentPath)];
    }
    const result = await showOpenDialog(event, {
      title: input?.txtOnly ? "选择 TXT 文案" : "选择 TXT 或 DOCX 文档",
      properties: input?.multiple ? ["openFile", "multiSelections"] : ["openFile"],
      filters: [{ name: "文本文档", extensions: input?.txtOnly ? ["txt"] : ["txt", "docx"] }],
    });
    if (result.canceled) return [];
    return Promise.all(result.filePaths.map((filePath) => readDocument(filePath)));
  });
  ipcMain.handle(IPC.filesImportDroppedDocuments, async (_event, pathsValue: unknown) => {
    const filePaths = z.array(localPath).min(1).parse(pathsValue);
    return Promise.all(filePaths.map((filePath) => readDocument(filePath)));
  });
  ipcMain.handle(IPC.filesFetchQqNovel, (_event, urlValue: unknown) =>
    process.env.AI_TOOL_TEST_INTERACTION_AUDIT === "1" && process.env.AI_TOOL_TEST_QQ_NOVEL_PATH?.trim()
      ? readFile(process.env.AI_TOOL_TEST_QQ_NOVEL_PATH.trim(), "utf8").then((text) => ({
          url: z.string().trim().min(1).max(4_096).parse(urlValue),
          title: "交互审计小说",
          text,
        }))
      : fetchQqNovel(z.string().trim().min(1).max(4_096).parse(urlValue)),
  );
  ipcMain.handle(IPC.filesPickCsv, async (event) => {
    const auditCsvPath = process.env.AI_TOOL_TEST_CSV_PATH?.trim();
    if (process.env.AI_TOOL_TEST_INTERACTION_AUDIT === "1" && auditCsvPath) {
      return { path: auditCsvPath, ...(await readCsvFile(auditCsvPath)) };
    }
    const result = await showOpenDialog(event, {
      title: "选择 CSV 分镜表",
      properties: ["openFile"],
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    return { path: filePath, ...(await readCsvFile(filePath)) };
  });
  ipcMain.handle(IPC.filesCopyIntoDirectory, (_event, inputValue: unknown) => {
    const input = z.object({
      sourcePath: localPath,
      directory: localPath,
      fileName: defaultName.optional(),
    }).strict().parse(inputValue);
    return copyFileIntoDirectory(input.sourcePath, input.directory, input.fileName);
  });
  ipcMain.handle(IPC.filesReadSubtitle, (_event, projectIdValue: unknown) => {
    const project = projects.get(z.number().int().positive().parse(projectIdValue));
    return readSrtFile(project.subtitlePath);
  });
  ipcMain.handle(IPC.filesPickFile, async (event, kindValue: unknown) => {
    const kind = z.enum(["visual", "audio", "subtitle", "executable"]).parse(kindValue);
    const auditPath = process.env[`AI_TOOL_TEST_${kind.toUpperCase()}_PATH`]?.trim();
    if (process.env.AI_TOOL_TEST_INTERACTION_AUDIT === "1" && auditPath) return auditPath;
    const optionsByKind: Record<typeof kind, { title: string; filters: Electron.FileFilter[] }> = {
      visual: {
        title: "选择画面素材",
        filters: [
          { name: "视频与图片", extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v", "jpg", "jpeg", "png", "webp", "bmp"] },
        ],
      },
      audio: {
        title: "选择音频素材",
        filters: [{ name: "音频", extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg"] }],
      },
      subtitle: {
        title: "选择字幕文件",
        filters: [{ name: "SRT 字幕", extensions: ["srt"] }],
      },
      executable: {
        title: "选择可执行文件",
        filters: [{ name: "可执行文件", extensions: ["exe"] }],
      },
    };
    const result = await showOpenDialog(event, { ...optionsByKind[kind], properties: ["openFile"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.filesPickDirectory, async (event, titleValue: unknown) => {
    const title = z.string().trim().min(1).max(120).optional().parse(titleValue);
    const auditDirectoryPath = process.env.AI_TOOL_TEST_DIRECTORY_PATH?.trim();
    if (process.env.AI_TOOL_TEST_INTERACTION_AUDIT === "1" && auditDirectoryPath) {
      return localPath.parse(auditDirectoryPath);
    }
    const result = await showOpenDialog(event, {
      title: title ?? "选择目录",
      defaultPath: paths.projects,
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.filesExportText, async (event, input: unknown) => {
    const value = z.object({ defaultName, text: z.string().max(100_000_000) }).strict().parse(input);
    const result = await showSaveDialog(event, {
      title: "导出 TXT",
      defaultPath: join(paths.projects, value.defaultName),
      filters: [{ name: "TXT", extensions: ["txt"] }],
    });
    if (result.canceled || !result.filePath) return null;
    return writeTextFileAtomic(result.filePath, value.text);
  });
  ipcMain.handle(IPC.filesWriteText, async (_event, input: unknown) => {
    const value = z.object({ directory: localPath, defaultName, text: z.string().max(100_000_000) }).strict().parse(input);
    if (basename(value.defaultName) !== value.defaultName) throw new Error("导出文件名不能包含目录");
    return writeTextFileAtomic(join(value.directory, value.defaultName), value.text);
  });
  ipcMain.handle(IPC.filesOpenPath, async (_event, pathValue: unknown) => {
    const filePath = localPath.parse(pathValue);
    if (process.env.AI_TOOL_TEST_INTERACTION_AUDIT === "1") {
      await access(filePath);
      return;
    }
    const error = await shell.openPath(filePath);
    if (error) throw new Error(`无法打开路径：${error}`);
  });
  ipcMain.handle(IPC.filesExportCsv, async (event, input: unknown) => {
    const value = z.object({
      defaultName,
      rows: z.array(csvRecord).max(100_000),
      columns: z.array(z.string().min(1).max(240)).max(1_000).optional(),
    }).strict().parse(input);
    const result = await showSaveDialog(event, {
      title: "导出 CSV",
      defaultPath: join(paths.projects, value.defaultName),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (result.canceled || !result.filePath) return null;
    return writeCsvFileAtomic(result.filePath, value.rows, { columns: value.columns });
  });
  ipcMain.handle(IPC.mediaHealth, (_event, input: unknown) => checkMediaHealth(mediaBinaryInput.parse(input)));
  const boundMediaFile = async (input: unknown): Promise<string> => {
    const filePath = await resolveBoundLocalMediaFile(storyboards, localMediaReference(localMediaSelector.parse(input)));
    if (!filePath) throw new Error("媒体文件不存在、不可读取或未绑定到该分镜");
    return filePath;
  };
  ipcMain.handle(IPC.mediaOpen, async (_event, input: unknown) => {
    const filePath = await boundMediaFile(input);
    if (process.env.AI_TOOL_TEST_INTERACTION_AUDIT === "1") return;
    const error = await shell.openPath(filePath);
    if (error) throw new Error("无法使用系统默认程序打开媒体文件");
  });
  ipcMain.handle(IPC.mediaReveal, async (_event, input: unknown) => {
    shell.showItemInFolder(await boundMediaFile(input));
  });
  ipcMain.handle(IPC.jianyingExport, async (_event, input: unknown) => {
    const parsed = jianyingInput.parse(input);
    const hydrated = await hydrateJianyingMediaMetadata(parsed, {
      ffprobePath: settings.get("ffprobe_path")?.trim() || undefined,
    });
    return exportJianyingDraft(hydrated);
  });
  ipcMain.handle(IPC.modelsProbe, async (_event, prefixValue: unknown) => {
    const prefix = z.enum(["infer", "text_polish", "imagegen"]).parse(prefixValue) as ModelProbePrefix;
    const provider = prefix === "imagegen" && settings.get("imagegen_provider")?.trim() === "gemini"
      ? "gemini"
      : "openai";
    const keys = parseApiKeys(settings.get(`${prefix}_api_key`), settings.get(`${prefix}_api_keys`));
    return probeModelConnection({
      provider,
      baseUrl: settings.get(`${prefix}_api_base_url`)?.trim() || "",
      apiKey: keys[0],
      model: settings.get(`${prefix}_model`)?.trim() || undefined,
    });
  });
  ipcMain.handle(IPC.backupCreate, async (event) => {
    const result = await showOpenDialog(event, {
      title: "选择备份保存目录",
      defaultPath: dirname(paths.userData),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return backup.create(result.filePaths[0]);
  });
  ipcMain.handle(IPC.backupValidate, async (event) => {
    const result = await showOpenDialog(event, {
      title: "选择 AI工具 备份目录",
      defaultPath: dirname(paths.userData),
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return backup.validate(result.filePaths[0]);
  });
  ipcMain.handle(IPC.backupRestore, async (event) => {
    const result = await showOpenDialog(event, {
      title: "选择要恢复的 AI工具 备份目录",
      defaultPath: dirname(paths.userData),
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const prepared = await backup.restore(result.filePaths[0]);
    setTimeout(() => backup.restart(), 1_500);
    return prepared;
  });
  ipcMain.handle(IPC.backupRestoreStatus, () => backup.restoreStatus());
}
