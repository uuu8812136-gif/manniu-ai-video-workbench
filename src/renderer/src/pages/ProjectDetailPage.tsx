import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import {
  ArrowLeft,
  Captions,
  Check,
  Clapperboard,
  FileDown,
  FileInput,
  FileText,
  FolderCog,
  FolderOpen,
  ImagePlus,
  Link2,
  ListChecks,
  Music,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Square,
  TableProperties,
  Trash2,
} from "lucide-react";
import type {
  LocalMediaSelector,
} from "../../../shared/local-media";
import type {
  CharacterProfile,
  Project,
  Storyboard,
  StoryboardDraft,
  UpdateStoryboardInput,
  ViduAccount,
  ViduModel,
  VideoJobInput,
  VideoProvider,
  WorkflowJob,
  WorkflowJobEvent,
} from "../../../shared/contracts";
import { StoryboardMediaPreview } from "../components/StoryboardMediaPreview";
import { ModalDialog } from "../components/ModalDialog";
import {
  STORYBOARD_CSV_COLUMNS,
  activeMediaJobsForStoryboards,
  buildJianyingExportInput,
  buildSrtDrivenJianyingExportPlan,
  latestImagePath,
  safeExportName,
  storyboardCsvRecords,
  storyboardPlainText,
  storyboardReplacementConfirmation,
  storyboardRowsFromCsv,
} from "../lib/project-files";
import {
  checkableVideoStoryboards,
  projectStoryboardJobs,
  storyboardDisplayState,
  storyboardJob,
  type StoryboardDisplayState,
} from "./storyboard-display-state";
import {
  DEFAULT_PROJECT_BATCH_EDIT_SCOPE,
  activeSubjectPreparation,
  freshProjectBatchEditState,
  partitionVideoGenerationSelection,
  previewProjectBatchEdit,
  videoGenerationTargets,
  type ProjectBatchEditScope,
} from "./project-batch-state";
import { projectAssetDirectoryPath } from "../../../shared/asset-names";
import { originalStoryboardDuration } from "../../../shared/storyboard-duration";
import { pendingProjectAssetNames } from "./project-assets-state";

type Props = {
  project: Project;
  onBack(): void;
  onProjectChange(project: Project): void;
};

const ACTIVE_STATUSES = new Set(["queued", "running", "paused"]);

function draftsFromText(text: string): StoryboardDraft[] {
  return text
    .split(/\r?\n\s*\r?\n|\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({
      index,
      originalText: line,
      prompt: "",
      subjects: [],
      duration: originalStoryboardDuration(line),
    }));
}

function shortPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function mediaSelector(storyboard: Storyboard, state: StoryboardDisplayState): LocalMediaSelector | null {
  if (state.mediaKind === "video") return { storyboardId: storyboard.id, kind: "video" };
  if (state.mediaKind === "image" && state.imageIndex !== null) {
    return { storyboardId: storyboard.id, kind: "image", index: state.imageIndex };
  }
  return null;
}

function reconcileUpdatedRecords<T extends { id: string | number; updatedAt: string }>(current: T[], next: T[]): T[] {
  if (current.length !== next.length) return next;
  let changed = false;
  const merged = next.map((entry, index) => {
    const previous = current[index];
    if (previous?.id === entry.id && previous.updatedAt === entry.updatedAt) return previous;
    changed = true;
    return entry;
  });
  return changed ? merged : current;
}

function reconcileJobEvents(
  current: Record<string, WorkflowJobEvent[]>,
  next: Record<string, WorkflowJobEvent[]>,
): Record<string, WorkflowJobEvent[]> {
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (currentKeys.length !== nextKeys.length) return next;
  for (const key of nextKeys) {
    const previous = current[key];
    const incoming = next[key];
    if (!previous || previous.length !== incoming.length) return next;
    if (incoming.some((event, index) => previous[index]?.id !== event.id || previous[index]?.createdAt !== event.createdAt)) return next;
  }
  return current;
}

export function ProjectDetailPage({ project, onBack, onProjectChange }: Props): ReactElement {
  const [storyboards, setStoryboards] = useState<Storyboard[]>([]);
  const [characterProfiles, setCharacterProfiles] = useState<CharacterProfile[]>([]);
  const [jobs, setJobs] = useState<WorkflowJob[]>([]);
  const [jobEvents, setJobEvents] = useState<Record<string, WorkflowJobEvent[]>>({});
  const [name, setName] = useState(project.name);
  const [sourceText, setSourceText] = useState("");
  const [showImporter, setShowImporter] = useState(false);
  const [showBatchEditor, setShowBatchEditor] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [batchDuration, setBatchDuration] = useState("");
  const [batchScope, setBatchScope] = useState<ProjectBatchEditScope>(DEFAULT_PROJECT_BATCH_EDIT_SCOPE);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState<string | null>(null);
  const [provider, setProvider] = useState<VideoProvider>("custom-api");
  const [viduModel, setViduModel] = useState<ViduModel>("Q3");
  const [useCredits, setUseCredits] = useState(true);
  const [preferQ3, setPreferQ3] = useState(true);
  const [q3PreCount, setQ3PreCount] = useState(0);
  const [viduAccounts, setViduAccounts] = useState<ViduAccount[]>([]);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [autoClip, setAutoClip] = useState(false);
  const [failedMediaIds, setFailedMediaIds] = useState<Set<number>>(new Set());
  const [editingStoryboard, setEditingStoryboard] = useState<Storyboard | null>(null);
  const [editOriginalText, setEditOriginalText] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editDuration, setEditDuration] = useState("4");
  const [uncertainStoryboard, setUncertainStoryboard] = useState<Storyboard | null>(null);
  const [uncertainTaskId, setUncertainTaskId] = useState("");
  const [uncertainClearConfirmed, setUncertainClearConfirmed] = useState(false);
  const [deleteAfterUncertainClear, setDeleteAfterUncertainClear] = useState(false);
  const [deletingStoryboard, setDeletingStoryboard] = useState<Storyboard | null>(null);
  const [forceDeleteTrackedVideo, setForceDeleteTrackedVideo] = useState(false);
  const [showResetConfirmation, setShowResetConfirmation] = useState(false);

  const pendingAssetNames = useMemo(
    () => pendingProjectAssetNames(storyboards, characterProfiles),
    [storyboards, characterProfiles],
  );
  const assetCount = characterProfiles.length + pendingAssetNames.length;

  const refresh = useCallback(async (quiet = false): Promise<void> => {
    try {
      const [nextStoryboards, nextProfiles, nextViduAccounts] = await Promise.all([
        window.offline.storyboards.list(project.id),
        window.offline.characterProfiles.list(project.id),
        window.offline.vidu.listAccounts(),
      ]);
      const nextJobs = await window.offline.jobs.latestForStoryboards(nextStoryboards.map(({ id }) => id));
      const hasVideoFailure = nextJobs.some((job) => job.type === "video.generate" && job.status === "error")
        || nextStoryboards.some((storyboard) => storyboard.videoSubmissionState === "uncertain");
      if (hasVideoFailure) {
        setNotice((current) => current.startsWith("已加入") ? "" : current);
      }
      setStoryboards((current) => reconcileUpdatedRecords(current, nextStoryboards));
      setCharacterProfiles((current) => reconcileUpdatedRecords(current, nextProfiles));
      setJobs((current) => reconcileUpdatedRecords(current, nextJobs));
      setViduAccounts((current) => reconcileUpdatedRecords(current, nextViduAccounts));
      const activeVideoJobs = projectStoryboardJobs(nextStoryboards, nextJobs)
        .filter((job) => job.status === "running");
      const eventEntries = await Promise.all(activeVideoJobs.map(async (job) => [job.id, await window.offline.jobs.events(job.id, 50)] as const));
      const nextJobEvents = Object.fromEntries(eventEntries);
      setJobEvents((current) => reconcileJobEvents(current, nextJobEvents));
      if (!quiet) setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [project.id]);

  useEffect(() => {
    setName(project.name);
    setSelectedIds(new Set());
    setFailedMediaIds(new Set());
    void refresh();
    let disposed = false;
    let timer: number | null = null;
    const poll = async (): Promise<void> => {
      await refresh(true);
      if (!disposed) timer = window.setTimeout(() => void poll(), 5_000);
    };
    timer = window.setTimeout(() => void poll(), 5_000);
    const onFocus = (): void => { void refresh(true); };
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [project.id, project.name, refresh]);

  useEffect(() => {
    void Promise.all([
      window.offline.settings.get("video_provider"),
      window.offline.settings.get("vidu_model"),
      window.offline.settings.get("vidu_use_credits"),
      window.offline.settings.get("video_aspect_ratio"),
      window.offline.settings.get(`project_${project.id}_auto_clip`),
      window.offline.settings.get(`project_${project.id}_vidu_q3_enabled`),
      window.offline.settings.get(`project_${project.id}_vidu_q3_pre_count`),
    ]).then(([savedProvider, savedModel, savedCredits, savedAspectRatio, savedAutoClip, savedQ3Enabled, savedQ3PreCount]) => {
      setProvider(savedProvider === "vidu-browser" ? "vidu-browser" : "custom-api");
      setViduModel(savedModel?.toUpperCase() === "Q2" ? "Q2" : "Q3");
      setUseCredits(savedCredits !== "false");
      setPreferQ3(savedQ3Enabled === null ? savedModel?.toUpperCase() !== "Q2" : savedQ3Enabled === "true");
      const parsedQ3PreCount = Number(savedQ3PreCount);
      setQ3PreCount(Number.isInteger(parsedQ3PreCount) && parsedQ3PreCount >= 0 && parsedQ3PreCount <= 9_999 ? parsedQ3PreCount : 0);
      setAspectRatio(savedAspectRatio || "16:9");
      setAutoClip(savedAutoClip === "true");
    }).catch((reason) => setError(String(reason)));
  }, [project.id]);

  const displayStates = useMemo(() => new Map(
    storyboards.map((storyboard) => [storyboard.id, storyboardDisplayState(storyboard, jobs)]),
  ), [jobs, storyboards]);
  const projectJobs = useMemo(() => projectStoryboardJobs(storyboards, jobs), [jobs, storyboards]);
  const activeJobs = useMemo(
    () => projectJobs.filter((job) => ACTIVE_STATUSES.has(job.status)),
    [projectJobs],
  );
  const subjectPreparation = useMemo(
    () => activeSubjectPreparation(projectJobs, jobEvents),
    [jobEvents, projectJobs],
  );
  const stats = useMemo(() => {
    const states = [...displayStates.values()];
    return {
      total: storyboards.length,
      done: storyboards.filter((storyboard) => Boolean(storyboard.videoPath)).length,
      active: states.filter((state) => ["queued", "generating", "paused"].includes(state.status)).length,
      errors: states.filter((state) => state.status === "error" || state.status === "uncertain").length,
      sent: storyboards.reduce((sum, item) => sum + item.submitCount, 0),
    };
  }, [displayStates, storyboards]);
  const completionPercent = stats.total > 0 ? Math.round(stats.done / stats.total * 100) : 0;
  const failureGroups = useMemo(() => {
    const groups = new Map<string, { count: number; storyboards: number[] }>();
    for (const storyboard of storyboards) {
      const state = displayStates.get(storyboard.id);
      if (!state || (state.status !== "error" && state.status !== "uncertain")) continue;
      const reason = state.detail.trim() || (state.status === "uncertain" ? "提交结果待确认" : "生成失败，暂无详细原因");
      const current = groups.get(reason) ?? { count: 0, storyboards: [] };
      current.count += 1;
      current.storyboards.push(storyboard.index + 1);
      groups.set(reason, current);
    }
    return [...groups.entries()]
      .map(([reason, group]) => ({ reason, ...group }))
      .sort((left, right) => right.count - left.count || left.storyboards[0] - right.storyboards[0]);
  }, [displayStates, storyboards]);
  const accountPool = useMemo(() => {
    const enabled = viduAccounts.filter((account) => account.enabled);
    const total = enabled.reduce((sum, account) => sum + account.defaultQuota, 0);
    const used = enabled.reduce((sum, account) => sum + account.usageCount, 0);
    return {
      enabledCount: enabled.length,
      total,
      used,
      remaining: enabled.reduce((sum, account) => sum + Math.max(0, account.defaultQuota - account.usageCount), 0),
      percent: total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0,
      issues: viduAccounts.filter((account) => Boolean(account.disabledReason || account.disabledMessage)),
    };
  }, [viduAccounts]);
  const hasVideoAccount = provider !== "vidu-browser" || accountPool.enabledCount > 0;
  const checkableStoryboards = useMemo(
    () => checkableVideoStoryboards(storyboards, jobs),
    [jobs, storyboards],
  );
  const runnable = useMemo(() => storyboards.filter((storyboard) => {
    const job = storyboardJob(storyboard.id, jobs, "video.generate");
    return storyboard.prompt.trim()
      && storyboard.videoSubmissionState !== "uncertain"
      && (!job || !ACTIVE_STATUSES.has(job.status))
      && (!storyboard.videoPath || failedMediaIds.has(storyboard.id));
  }), [failedMediaIds, jobs, storyboards]);
  const selectedStoryboards = useMemo(
    () => storyboards.filter((storyboard) => selectedIds.has(storyboard.id)),
    [selectedIds, storyboards],
  );
  const batchDurationValue = batchDuration.trim() ? Number(batchDuration) : null;
  const batchFindText = findText.trim();
  const batchEditPreview = useMemo(
    () => previewProjectBatchEdit(
      storyboards,
      jobs,
      selectedIds,
      batchScope,
      batchFindText,
      batchDurationValue !== null,
    ),
    [batchDurationValue, batchFindText, batchScope, jobs, selectedIds, storyboards],
  );
  const editableBatchPreview = useMemo(
    () => previewProjectBatchEdit(storyboards, jobs, new Set(), "editable", "", false),
    [jobs, storyboards],
  );
  const editableBatchCount = editableBatchPreview.candidates.length - editableBatchPreview.skippedActive.length;

  const toggleBatchEditor = (): void => {
    if (showBatchEditor) {
      setShowBatchEditor(false);
      return;
    }
    const fresh = freshProjectBatchEditState();
    setFindText(fresh.findText);
    setReplaceText(fresh.replaceText);
    setBatchDuration(fresh.duration);
    setBatchScope(fresh.scope);
    setShowBatchEditor(true);
  };

  const saveName = async (): Promise<void> => {
    if (!name.trim() || name.trim() === project.name) return;
    const updated = await window.offline.projects.update(project.id, { name });
    onProjectChange(updated);
  };

  const assertNoActiveMediaJobs = async (storyboardIds: number[], action: string): Promise<void> => {
    const active = activeMediaJobsForStoryboards(await window.offline.jobs.list(), storyboardIds);
    if (active.length === 0) return;
    throw new Error(`无法${action}：关联分镜仍有 ${active.length} 个生图或视频任务处于排队、运行或暂停状态，请先在批量任务中取消。`);
  };

  const replaceFromText = async (): Promise<void> => {
    const drafts = draftsFromText(sourceText);
    if (drafts.length === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await assertNoActiveMediaJobs(storyboards.map((item) => item.id), "替换分镜");
      const confirmation = storyboardReplacementConfirmation(storyboards.length, drafts.length, "文本");
      if (confirmation && !confirm(confirmation)) return;
      setStoryboards(await window.offline.storyboards.replace(project.id, drafts));
      setSourceText("");
      setShowImporter(false);
      setSelectedIds(new Set());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const runFileAction = async (actionName: string, action: () => Promise<void>): Promise<void> => {
    setFileBusy(actionName);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setFileBusy(null);
    }
  };

  const importDocument = async (): Promise<void> => runFileAction("document", async () => {
    const document = await window.offline.files.pickDocument();
    if (!document) return;
    setSourceText(document.text);
    setShowImporter(true);
    const warning = document.warnings[0] ? `；${document.warnings[0]}` : "";
    setNotice(`已读取 ${document.path}（${document.format.toUpperCase()} / ${document.encoding}）${warning}`);
  });

  const importCsv = async (): Promise<void> => runFileAction("csv-import", async () => {
    const csv = await window.offline.files.pickCsv();
    if (!csv) return;
    if (csv.errors.length > 0) throw new Error(`CSV 解析失败：${csv.errors.slice(0, 3).map((issue) => issue.message).join("；")}`);
    const parsedRows = storyboardRowsFromCsv(csv);
    if (parsedRows.length === 0) throw new Error("CSV 中没有可导入的分镜数据");
    await assertNoActiveMediaJobs(storyboards.map((item) => item.id), "用 CSV 替换分镜");
    const confirmation = storyboardReplacementConfirmation(storyboards.length, parsedRows.length, "CSV");
    if (confirmation && !confirm(confirmation)) return;
    const projectDirectory = project.folderPath.trim();
    if (!projectDirectory) throw new Error("项目目录未配置，CSV 未导入，原有分镜保持不变");
    let copiedCsvPath: string;
    try {
      copiedCsvPath = await window.offline.files.copyIntoDirectory({
        sourcePath: csv.path,
        directory: projectDirectory,
      });
    } catch (reason) {
      throw new Error(`CSV 复制到项目目录失败，未替换原有分镜：${reason instanceof Error ? reason.message : String(reason)}`);
    }
    let imported = await window.offline.storyboards.replace(project.id, parsedRows.map((row) => row.draft));
    for (const row of parsedRows) {
      const importedStoryboard = imported.find((item) => item.index === row.draft.index);
      if (!row.mediaPath || !row.mediaKind || !importedStoryboard) continue;
      const changed = await window.offline.storyboards.update(importedStoryboard.id, row.mediaKind === "video"
        ? { videoPath: row.mediaPath, imagePaths: [], status: "done" }
        : { videoPath: null, imagePaths: [row.mediaPath], status: "done" });
      imported = imported.map((item) => item.id === changed.id ? changed : item);
    }
    setStoryboards(imported);
    const updatedProject = await window.offline.projects.update(project.id, { csvPath: copiedCsvPath });
    onProjectChange(updatedProject);
    setNotice(`已导入 ${parsedRows.length} 个分镜，CSV 已复制到项目目录：${copiedCsvPath}`);
  });

  const exportText = async (): Promise<void> => runFileAction("text-export", async () => {
    const text = storyboardPlainText(storyboards);
    if (!text) throw new Error("当前项目没有可导出的文本");
    const path = await window.offline.files.exportText({ defaultName: safeExportName(project.name, "txt"), text });
    if (path) setNotice(`TXT 已导出：${path}`);
  });

  const exportCsv = async (): Promise<void> => runFileAction("csv-export", async () => {
    if (storyboards.length === 0) throw new Error("当前项目没有可导出的分镜");
    const path = await window.offline.files.exportCsv({
      defaultName: safeExportName(project.name, "csv"),
      columns: [...STORYBOARD_CSV_COLUMNS],
      rows: storyboardCsvRecords(storyboards),
    });
    if (!path) return;
    const updatedProject = await window.offline.projects.update(project.id, { csvPath: path });
    onProjectChange(updatedProject);
    setNotice(`CSV 已导出：${path}`);
  });

  const selectAudio = async (): Promise<void> => runFileAction("audio", async () => {
    const path = await window.offline.files.pickFile("audio");
    if (!path) return;
    const updatedProject = await window.offline.projects.update(project.id, { audioPath: path });
    onProjectChange(updatedProject);
    setNotice(`旁白音频已选择：${path}`);
  });

  const openProjectFolder = async (): Promise<void> => runFileAction("project-folder-open", async () => {
    if (!project.folderPath.trim()) throw new Error("项目目录未配置");
    await window.offline.files.openPath(project.folderPath);
  });

  const openAssetFolder = async (): Promise<void> => runFileAction("asset-folder-open", async () => {
    if (!project.folderPath.trim()) throw new Error("项目目录未配置");
    await window.offline.files.openPath(projectAssetDirectoryPath(project.folderPath));
  });

  const selectProjectFolder = async (): Promise<void> => runFileAction("project-folder-change", async () => {
    await assertNoActiveMediaJobs(storyboards.map((item) => item.id), "修改项目目录");
    const path = await window.offline.files.pickDirectory("选择项目素材与生成结果目录");
    if (!path) return;
    const updatedProject = await window.offline.projects.update(project.id, { folderPath: path });
    onProjectChange(updatedProject);
    setNotice(`项目目录已更新：${path}`);
  });

  const selectSubtitle = async (): Promise<void> => runFileAction("subtitle", async () => {
    const path = await window.offline.files.pickFile("subtitle");
    if (!path) return;
    const updatedProject = await window.offline.projects.update(project.id, { subtitlePath: path });
    onProjectChange(updatedProject);
    setNotice(`字幕文件已选择：${path}`);
  });

  const exportJianying = async (): Promise<void> => runFileAction("jianying", async () => {
    if (storyboards.length === 0) throw new Error("请先创建分镜");
    let draftRoot = (await window.offline.settings.get("jianying_draft_path"))?.trim() ?? "";
    if (!draftRoot) draftRoot = (await window.offline.app.paths()).jianyingDrafts.trim();
    if (!draftRoot) {
      draftRoot = await window.offline.files.pickDirectory("选择剪映草稿目录") ?? "";
      if (!draftRoot) return;
      await window.offline.settings.set("jianying_draft_path", draftRoot);
    }
    let input = buildJianyingExportInput(project, storyboards, draftRoot, true);
    let alignmentSummary = "按分镜原始时长排列，不调整视频速度";
    const missingStoryboardIndexes = storyboards
      .filter((item) => !item.videoPath && item.imagePaths.length === 0)
      .map((item) => item.index + 1);
    if (autoClip && !project.subtitlePath.trim()) {
      throw new Error("已开启自动剪辑，请先选择 SRT 字幕文件");
    }
    if (autoClip) {
      const subtitle = await window.offline.files.readSubtitle(project.id);
      const plan = buildSrtDrivenJianyingExportPlan(project, storyboards, draftRoot, subtitle.cues, true);
      input = plan.input;
      const percent = (plan.match.matchRate * 100).toFixed(0);
      alignmentSummary = `SRT 匹配率 ${percent}%`;
      if (plan.match.inferredStoryboardIndexes.length > 0) {
        alignmentSummary += `，镜头 ${plan.match.inferredStoryboardIndexes.map((index) => index + 1).join("、")} 的时间已按相邻字幕推算`;
      }
      if (plan.match.unmatchedStoryboardIndexes.length > 0) {
        alignmentSummary += `，镜头 ${plan.match.unmatchedStoryboardIndexes.map((index) => index + 1).join("、")} 未匹配并按分镜时长估算`;
      }
      if (subtitle.warnings.length > 0) alignmentSummary += `，跳过 ${subtitle.warnings.length} 个无效字幕段`;
    } else if (project.subtitlePath.trim()) {
      try {
        const subtitle = await window.offline.files.readSubtitle(project.id);
        input = { ...input, subtitles: subtitle.cues.map((cue) => ({ ...cue })) };
        alignmentSummary = `字幕已导入（${subtitle.cues.length} 段），视频保持原速`;
        if (subtitle.warnings.length > 0) alignmentSummary += `，跳过 ${subtitle.warnings.length} 个无效字幕段`;
      } catch (reason) {
        alignmentSummary = `字幕读取失败，已按无字幕原速导出：${reason instanceof Error ? reason.message : String(reason)}`;
      }
    }
    const missingSummary = missingStoryboardIndexes.length > 0
      ? `\n缺少画面的镜头：${missingStoryboardIndexes.join("、")}，对应时段将保留黑场。`
      : "";
    const modeSummary = autoClip
      ? "自动剪辑会按 SRT 对齐画面并调整视频速度"
      : "普通导出不会调整视频速度";
    if (!confirm(`导出剪映草稿“${project.name}”？\n${alignmentSummary}${missingSummary}\n${modeSummary}；已有同名草稿将被替换。`)) return;
    const result = await window.offline.jianying.export(input);
    setNotice(`剪映草稿已导出：${result.draftPath}（${alignmentSummary}，${result.validation.summary.segments} 个片段）`);
  });

  const append = async (): Promise<void> => {
    await window.offline.storyboards.create(project.id, {
      index: storyboards.length,
      originalText: "",
      prompt: "",
      subjects: [],
      duration: 4,
    });
    await refresh();
  };

  const update = async (item: Storyboard, patch: UpdateStoryboardInput): Promise<void> => {
    try {
      const changed = await window.offline.storyboards.update(item.id, patch);
      setStoryboards((current) => current.map((entry) => (entry.id === changed.id ? changed : entry)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const beginStoryboardEdit = (item: Storyboard): void => {
    const state = displayStates.get(item.id);
    if (state && ["queued", "generating", "paused"].includes(state.status)) return;
    setEditingStoryboard(item);
    setEditOriginalText(item.originalText);
    setEditPrompt(item.prompt);
    setEditDuration(String(item.duration));
  };

  const saveStoryboardEdit = async (): Promise<void> => {
    if (!editingStoryboard) return;
    const duration = Number(editDuration);
    if (!Number.isInteger(duration) || duration < 1 || duration > 600) {
      setError("分镜时长必须是 1 到 600 的整数");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const changed = await window.offline.storyboards.update(editingStoryboard.id, {
        originalText: editOriginalText,
        prompt: editPrompt,
        duration,
      });
      setStoryboards((current) => current.map((entry) => (entry.id === changed.id ? changed : entry)));
      setEditingStoryboard(null);
      setNotice(`分镜 ${editingStoryboard.index + 1} 已保存`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const selectVisual = async (item: Storyboard): Promise<void> => runFileAction(`visual-${item.id}`, async () => {
    const path = await window.offline.files.pickFile("visual");
    if (!path) return;
    const isVideo = /\.(?:mp4|mov|mkv|avi|webm|m4v)$/i.test(path);
    await update(item, isVideo
      ? { videoPath: path, imagePaths: [], status: "done" }
      : { videoPath: null, imagePaths: [path], status: "done" });
    setFailedMediaIds((current) => { const next = new Set(current); next.delete(item.id); return next; });
    setNotice(`分镜 ${item.index + 1} 的画面素材已选择：${path}`);
  });

  const openUncertainResolution = (storyboard: Storyboard, deleteAfterClear = false): void => {
    setUncertainStoryboard(storyboard);
    setUncertainTaskId("");
    setUncertainClearConfirmed(false);
    setDeleteAfterUncertainClear(deleteAfterClear);
  };

  const remove = async (item: Storyboard): Promise<void> => {
    setError("");
    setNotice("");
    try {
      if (item.videoSubmissionState === "uncertain") {
        openUncertainResolution(item, true);
        return;
      }
      const activeImageJob = storyboardJob(item.id, jobs, "image.generate");
      if (activeImageJob && ACTIVE_STATUSES.has(activeImageJob.status)) {
        throw new Error(`分镜 ${item.index + 1} 正在生成图片，请先停止当前任务再删除`);
      }
      const activeVideoJob = storyboardJob(item.id, jobs, "video.generate");
      const hasTrackedVideo = Boolean(item.videoTaskId)
        || item.videoSubmissionState === "submitting"
        || item.videoSubmissionState === "submitted"
        || Boolean(activeVideoJob && ACTIVE_STATUSES.has(activeVideoJob.status));
      setForceDeleteTrackedVideo(hasTrackedVideo);
      if (!hasTrackedVideo) await assertNoActiveMediaJobs([item.id], `删除分镜 ${item.index + 1}`);
      setDeletingStoryboard(item);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const confirmStoryboardDeletion = async (): Promise<void> => {
    if (!deletingStoryboard) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (forceDeleteTrackedVideo) {
        await window.offline.storyboards.forceStopVideo(deletingStoryboard.id);
      }
      await assertNoActiveMediaJobs([deletingStoryboard.id], `删除分镜 ${deletingStoryboard.index + 1}`);
      await window.offline.storyboards.delete(deletingStoryboard.id);
      setNotice(`分镜 ${deletingStoryboard.index + 1} 已删除`);
      setDeletingStoryboard(null);
      setForceDeleteTrackedVideo(false);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const persistAutomationOption = async (key: string, value: string): Promise<void> => {
    try {
      await window.offline.settings.set(key, value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const enqueueVideo = async (
    storyboard: Storyboard,
    forceRegeneration = false,
    priority = false,
    regenerationConfirmed = false,
    refreshAfterEnqueue = true,
  ): Promise<void> => {
    if (!storyboard.prompt.trim()) throw new Error(`分镜 ${storyboard.index + 1} 还没有画面提示词`);
    if (forceRegeneration && storyboard.videoPath && !regenerationConfirmed
      && !confirm(`重新生成分镜 ${storyboard.index + 1}？这会再次消耗额度或积分。`)) return;
    const input = {
      storyboardId: storyboard.id,
      provider,
      viduModel: preferQ3 ? "Q3" : viduModel,
      q3PreCount: preferQ3 ? q3PreCount : undefined,
      useCredits,
      durationSeconds: storyboard.duration,
      aspectRatio,
    };
    if (priority) await window.offline.jobs.enqueuePriority("video.generate", input);
    else await window.offline.jobs.enqueue("video.generate", input);
    if (priority) setNotice(`分镜 ${storyboard.index + 1} 已插到等待队列最前面`);
    if (refreshAfterEnqueue) await refresh(true);
  };

  const runStoryboardAction = async (action: () => Promise<void>): Promise<void> => {
    setError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const checkStoryboard = async (storyboard: Storyboard): Promise<void> => runStoryboardAction(async () => {
    const active = storyboardJob(storyboard.id, jobs, "video.generate");
    if (active && ACTIVE_STATUSES.has(active.status)) {
      if (active.status === "paused") await window.offline.jobs.resume(active.id);
      if (active.status === "queued") {
        await window.offline.jobs.enqueuePriority("video.generate", active.input as VideoJobInput);
      }
      if (storyboard.videoTaskId && storyboard.videoProvider === "vidu-browser") {
        const result = await window.offline.vidu.checkSubmission(storyboard.id);
        await refresh();
        setNotice(`分镜 ${storyboard.index + 1} 已立即查询 Vidu：${result.providerStatus}${result.progress === null ? "" : ` · ${result.progress}%`}`);
        return;
      }
      await refresh();
      setNotice(`分镜 ${storyboard.index + 1} 已恢复执行，正在等待网站任务 ID`);
      return;
    }
    if (storyboard.videoTaskId || storyboard.videoSubmissionState === "submitted") {
      if (storyboard.videoProvider === "vidu-browser") await window.offline.vidu.checkSubmission(storyboard.id);
      await enqueueVideo(storyboard);
      setNotice(`分镜 ${storyboard.index + 1} 已恢复检查，不会重复提交`);
      return;
    }
    await refresh();
    setNotice(`分镜 ${storyboard.index + 1} 没有待追踪的网站任务`);
  });

  const bindUncertainTask = async (): Promise<void> => {
    if (!uncertainStoryboard || !uncertainTaskId.trim()) return;
    const storyboard = uncertainStoryboard;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await window.offline.vidu.resolveUncertain(storyboard.id, { taskId: uncertainTaskId.trim() });
      await enqueueVideo(storyboard);
      setNotice(`分镜 ${storyboard.index + 1} 已绑定网站任务，正在恢复检查`);
      setUncertainStoryboard(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const clearUncertainSubmission = async (): Promise<void> => {
    if (!uncertainStoryboard || !uncertainClearConfirmed) return;
    const storyboard = uncertainStoryboard;
    const continueToDelete = deleteAfterUncertainClear;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await window.offline.vidu.resolveUncertain(storyboard.id, { clear: true });
      setUncertainStoryboard(null);
      setUncertainClearConfirmed(false);
      setDeleteAfterUncertainClear(false);
      await refresh();
      if (continueToDelete) {
        setForceDeleteTrackedVideo(false);
        setDeletingStoryboard(storyboard);
        setNotice(`分镜 ${storyboard.index + 1} 已解除待确认状态，请确认删除`);
      } else {
        setNotice(`分镜 ${storyboard.index + 1} 已解除待确认状态，现在可以重发或删除`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const retryStoryboard = async (storyboard: Storyboard): Promise<void> => runStoryboardAction(async () => {
    const failedJob = storyboardJob(storyboard.id, jobs, "video.generate");
    if (failedJob?.status === "error") await window.offline.jobs.retry(failedJob.id);
    else await enqueueVideo(storyboard, Boolean(storyboard.videoPath));
    await refresh(true);
  });

  const stopStoryboard = async (storyboard: Storyboard): Promise<void> => runStoryboardAction(async () => {
    const job = storyboardJob(storyboard.id, jobs);
    if (!job || !ACTIVE_STATUSES.has(job.status)) return;
    if (job.type === "video.generate") {
      if (!window.confirm(`强制停止分镜 ${storyboard.index + 1}？本地 task ID 将清除，网站任务可能仍会继续生成。`)) return;
      await window.offline.storyboards.forceStopVideo(storyboard.id);
    } else {
      await window.offline.jobs.cancel(job.id);
    }
    await refresh();
  });

  const generateMany = async (items: Storyboard[]): Promise<void> => {
    const selection = partitionVideoGenerationSelection(items);
    const regenerateExisting = selection.existing.length > 0 && confirm(
      `所选分镜中有 ${selection.existing.length} 个已经生成视频。\n\n重新生成这些视频会再次消耗 Vidu 额度或积分，是否继续？\n\n选择“取消”将只生成其余 ${selection.fresh.length} 个未生成分镜。`,
    );
    const targets = videoGenerationTargets(items, regenerateExisting);
    if (targets.length === 0) {
      setNotice(selection.existing.length > 0 ? `已跳过 ${selection.existing.length} 个已有视频，未产生新的付费任务` : "没有可生成的分镜");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    let added = 0;
    const failures: string[] = [];
    try {
      for (const storyboard of targets) {
        try {
          await enqueueVideo(storyboard, Boolean(storyboard.videoPath), false, regenerateExisting, false);
          added += 1;
        } catch (reason) {
          failures.push(`#${storyboard.index + 1} ${reason instanceof Error ? reason.message : String(reason)}`);
        }
      }
      if (failures.length > 0) setError(`有 ${failures.length} 个分镜未加入：${failures.slice(0, 3).join("；")}`);
      const skipped = regenerateExisting ? 0 : selection.existing.length;
      setNotice(`已加入 ${added} 个视频任务${skipped > 0 ? `，跳过 ${skipped} 个已有视频` : ""}`);
    } finally {
      setBusy(false);
      await refresh(true);
    }
  };

  const checkAll = async (): Promise<void> => {
    if (checkableStoryboards.length === 0) {
      setNotice("当前没有需要检查的生成中分镜");
      return;
    }
    for (const storyboard of checkableStoryboards) await checkStoryboard(storyboard);
    await refresh();
    setNotice(`已完成 ${checkableStoryboards.length} 个分镜检查`);
  };

  const applyBatchEdit = async (): Promise<void> => {
    const duration = batchDurationValue;
    if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 600)) {
      setError("批量时长必须是 1 到 600 的整数");
      return;
    }
    if (!batchFindText && duration === null) {
      setError("请填写提示词查找内容或批量时长");
      return;
    }
    if (batchEditPreview.targets.length === 0) {
      setError("当前范围没有命中可修改的分镜");
      return;
    }
    setBusy(true);
    try {
      for (const storyboard of batchEditPreview.targets) {
        const prompt = batchFindText && storyboard.prompt.includes(batchFindText)
          ? storyboard.prompt.split(batchFindText).join(replaceText)
          : storyboard.prompt;
        await window.offline.storyboards.update(storyboard.id, {
          prompt,
          ...(duration === null ? {} : { duration }),
        });
      }
      const skipped = batchEditPreview.skippedActive.length > 0
        ? `，跳过 ${batchEditPreview.skippedActive.length} 个生成中的分镜`
        : "";
      setNotice(`已修改 ${batchEditPreview.targets.length} 个分镜${skipped}`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAll = (): void => {
    setSelectedIds((current) => current.size === storyboards.length
      ? new Set()
      : new Set(storyboards.map((storyboard) => storyboard.id)));
  };

  const mediaAction = async (storyboard: Storyboard, state: StoryboardDisplayState, action: "open" | "reveal"): Promise<void> => {
    const selector = mediaSelector(storyboard, state);
    if (!selector) return;
    await runStoryboardAction(async () => {
      await window.offline.media[action](selector);
    });
  };

  const pauseAll = async (): Promise<void> => runStoryboardAction(async () => {
    await Promise.all(activeJobs.filter((job) => job.status === "running" || job.status === "queued").map((job) => window.offline.jobs.pause(job.id)));
    await refresh();
  });

  const resumeAll = async (): Promise<void> => runStoryboardAction(async () => {
    await Promise.all(activeJobs.filter((job) => job.status === "paused").map((job) => window.offline.jobs.resume(job.id)));
    await refresh();
  });

  const stopAll = async (): Promise<void> => runStoryboardAction(async () => {
    if (activeJobs.length === 0 || !confirm(`停止当前项目的 ${activeJobs.length} 个任务？已提交到网站的任务可能仍会继续生成。`)) return;
    await Promise.all(activeJobs.map((job) => {
      if (job.type !== "video.generate") return window.offline.jobs.cancel(job.id);
      const storyboardId = Number((job.input as { storyboardId?: unknown } | null)?.storyboardId);
      return Number.isInteger(storyboardId) && storyboardId > 0
        ? window.offline.storyboards.forceStopVideo(storyboardId)
        : window.offline.jobs.cancel(job.id);
    }));
    await refresh();
  });

  const resetProject = async (): Promise<void> => runStoryboardAction(async () => {
    if (activeJobs.length > 0) throw new Error("请先停止当前项目的全部生成任务，再清空重来");
    setBusy(true);
    try {
      const result = await window.offline.storyboards.resetProject(project.id);
      setSelectedIds(new Set());
      setFailedMediaIds(new Set());
      await refresh();
      setShowResetConfirmation(false);
      setNotice(`已重置 ${result.storyboardsReset} 个分镜并清理 ${result.jobsRemoved} 条任务记录，本地媒体文件已保留`);
    } finally {
      setBusy(false);
    }
  });

  return (
    <div className="page-shell project-detail-page">
      <div className="project-detail-workspace">
        <section className="project-storyboard-main">
          <div className="storyboard-commandbar">
            <div className="storyboard-commandbar-left">
              <button className="icon-button" title="返回项目列表" onClick={onBack}><ArrowLeft size={19} /></button>
              <label className="select-all-control">
                <input type="checkbox" checked={storyboards.length > 0 && selectedIds.size === storyboards.length} onChange={toggleAll} />
                <span>{selectedIds.size > 0 ? `已选 ${selectedIds.size}` : "全选"}</span>
              </label>
            </div>
            <div className="storyboard-commandbar-actions">
              <button className="primary-button compact-button" disabled={editableBatchCount === 0} onClick={toggleBatchEditor}><Settings2 size={16} /> 批量修改</button>
              <button className="secondary-button compact-button" disabled={checkableStoryboards.length === 0} onClick={() => void checkAll()}><RefreshCw size={16} /> 一键检查</button>
              <button className="secondary-button compact-button" disabled={selectedStoryboards.length === 0 || busy} onClick={() => void generateMany(selectedStoryboards)}><Play size={16} /> 生成所选</button>
              <details className="project-extra-tools">
                <summary className="secondary-button compact-button"><Settings2 size={16} /> 项目工具</summary>
                <div className="project-extra-tools-menu">
                  <label className="project-name-editor"><span>项目名称</span><input value={name} maxLength={160} onChange={(event) => setName(event.target.value)} onBlur={() => void saveName()} /></label>
                  <button className="secondary-button" onClick={() => setShowImporter((value) => !value)}><FileInput size={17} /> 导入文本</button>
                  <button className="secondary-button" disabled={fileBusy !== null} onClick={() => void importCsv()}><TableProperties size={17} /> 导入 CSV</button>
                  <button className="secondary-button" disabled={fileBusy !== null} onClick={() => void exportText()}><FileText size={17} /> 导出 TXT</button>
                  <button className="secondary-button" disabled={fileBusy !== null} onClick={() => void exportCsv()}><FileDown size={17} /> 导出 CSV</button>
                  <button className={project.audioPath ? "secondary-button selected-file" : "secondary-button"} title={project.audioPath || "选择旁白音频"} disabled={fileBusy !== null} onClick={() => void selectAudio()}><Music size={17} /> {project.audioPath ? "旁白已选" : "选择旁白"}</button>
                  <button className={project.subtitlePath ? "secondary-button selected-file" : "secondary-button"} title={project.subtitlePath || "选择字幕文件"} disabled={fileBusy !== null} onClick={() => void selectSubtitle()}><Captions size={17} /> {project.subtitlePath ? "字幕已选" : "选择字幕"}</button>
                  <button className={project.folderPath ? "secondary-button selected-file" : "secondary-button"} title={project.folderPath || "项目目录未配置"} disabled={fileBusy !== null || !project.folderPath} onClick={() => void openProjectFolder()}><FolderOpen size={17} /> 项目目录</button>
                  <button className="secondary-button" title="更改项目绑定目录" disabled={fileBusy !== null} onClick={() => void selectProjectFolder()}><FolderCog size={17} /> 更改目录</button>
                  <button className="secondary-button" onClick={() => void append()}><Plus size={17} /> 添加分镜</button>
                </div>
              </details>
            </div>
          </div>

          {showImporter && (
            <section className="import-panel project-inline-importer">
              <textarea value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder="粘贴文案，每行或每段生成一个分镜" />
              <div className="panel-actions">
                <div className="panel-action-left">
                  <button className="secondary-button" disabled={fileBusy !== null} onClick={() => void importDocument()}><FileInput size={16} /> 选择 TXT/DOCX</button>
                  <span>{draftsFromText(sourceText).length} 个分镜</span>
                </div>
                <button className="primary-button" disabled={busy || !sourceText.trim()} onClick={() => void replaceFromText()}>生成分镜表</button>
              </div>
            </section>
          )}

          {error && <div className="error-banner project-workspace-banner" role="alert">{error}</div>}
          {notice && <div className="success-banner file-notice project-workspace-banner">{notice}</div>}
          {subjectPreparation && (
            <div className="subject-preparation-banner" role="status" aria-live="polite">
              <div>
                <strong>角色注册中</strong>
                <span>{subjectPreparation.name || `分镜 ${(storyboards.find((item) => item.id === subjectPreparation.storyboardId)?.index ?? 0) + 1}`}</span>
              </div>
              <div className="progress-track" aria-label={`角色注册进度 ${subjectPreparation.current}/${subjectPreparation.total}`}>
                <div style={{ width: `${subjectPreparation.percent}%` }} />
              </div>
              <b>{subjectPreparation.current}/{subjectPreparation.total}</b>
            </div>
          )}

          {showBatchEditor && (
            <section className="batch-edit-panel">
              <div className="batch-edit-scope">
                <span>修改范围</span>
                <div className="segmented-control three compact">
                  <button className={batchScope === "selected" ? "selected" : ""} onClick={() => setBatchScope("selected")}>已选择</button>
                  <button className={batchScope === "editable" ? "selected" : ""} onClick={() => setBatchScope("editable")}>全部可编辑</button>
                  <button className={batchScope === "pending" ? "selected" : ""} onClick={() => setBatchScope("pending")}>待生成与失败</button>
                </div>
              </div>
              <label><span>查找提示词</span><div className="field-with-icon"><Search size={15} /><input value={findText} onChange={(event) => setFindText(event.target.value)} placeholder="要替换的内容" /></div></label>
              <label><span>替换为</span><input value={replaceText} onChange={(event) => setReplaceText(event.target.value)} placeholder="留空表示删除" /></label>
              <label className="batch-duration-field"><span>统一时长</span><input type="number" min={1} max={600} value={batchDuration} onChange={(event) => setBatchDuration(event.target.value)} placeholder="不修改" /></label>
              <div className="batch-edit-preview"><strong>{batchEditPreview.targets.length}</strong><span>条将修改</span><small>范围 {batchEditPreview.candidates.length} 条{batchEditPreview.skippedActive.length > 0 ? ` · 跳过生成中 ${batchEditPreview.skippedActive.length} 条` : ""}</small></div>
              <button className="primary-button" disabled={busy || batchEditPreview.targets.length === 0} onClick={() => void applyBatchEdit()}><Check size={16} /> 确认修改</button>
            </section>
          )}

          <div className="storyboard-card-list">
            {storyboards.map((item) => {
              const state = displayStates.get(item.id)!;
              const videoJob = storyboardJob(item.id, jobs, "video.generate");
              const active = Boolean(videoJob && ACTIVE_STATUSES.has(videoJob.status));
              const editable = !["queued", "generating", "paused"].includes(state.status);
              return (
                <article key={item.id} className={`storyboard-card-row ${state.status}`}>
                  <div className="storyboard-card-index">
                    <input type="checkbox" checked={selectedIds.has(item.id)} aria-label={`选择分镜 ${item.index + 1}`} onChange={() => setSelectedIds((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} />
                    <strong>#{item.index + 1}</strong>
                  </div>
                  <button className="storyboard-static-field original" disabled={!editable} title={editable ? "点击编辑分镜" : "生成期间不可编辑"} onClick={() => beginStoryboardEdit(item)}>{item.originalText || "未填写原文"}</button>
                  <button className="storyboard-static-field duration" disabled={!editable} title={editable ? "点击编辑时长" : "生成期间不可编辑"} onClick={() => beginStoryboardEdit(item)}>{item.duration}</button>
                  <button className="storyboard-static-field prompt" disabled={!editable} title={editable ? "点击编辑提示词" : "生成期间不可编辑"} onClick={() => beginStoryboardEdit(item)}>{item.prompt || "点击填写画面提示词"}</button>
                  <div className="storyboard-card-status">
                    <span className={`status-label ${state.status}`} title={state.detail}>{state.label}</span>
                    {state.progress !== null && ["queued", "generating"].includes(state.status) && <small className="status-progress">{state.progress}%</small>}
                  </div>
                  <div className="storyboard-card-media">
                    <StoryboardMediaPreview
                      storyboard={item}
                      state={state}
                      onOpen={() => void mediaAction(item, state, "open")}
                      onReveal={() => void mediaAction(item, state, "reveal")}
                      onLoadError={(id) => setFailedMediaIds((current) => new Set(current).add(id))}
                    />
                  </div>
                  <div className="storyboard-card-actions">
                    {item.videoSubmissionState === "uncertain" ? (
                      <button className="secondary-button compact-button" onClick={() => openUncertainResolution(item)}><Link2 size={15} /> 确认</button>
                    ) : active ? (
                      <>
                        <button className="secondary-button compact-button" onClick={() => void checkStoryboard(item)}><RefreshCw size={15} /> 检查</button>
                        <button className="icon-button danger" title="停止当前任务" onClick={() => void stopStoryboard(item)}><Square size={15} /></button>
                      </>
                    ) : item.videoTaskId && state.status === "generating" ? (
                      <button className="secondary-button compact-button" onClick={() => void checkStoryboard(item)}><RefreshCw size={15} /> 检查</button>
                    ) : state.status === "error" ? (
                      <button className="secondary-button compact-button" onClick={() => void (activeJobs.length > 0
                        ? runStoryboardAction(() => enqueueVideo(item, Boolean(item.videoPath), true))
                        : retryStoryboard(item))}><RotateCcw size={15} /> {activeJobs.length > 0 ? "插队" : "重试"}</button>
                    ) : (
                      <button className="secondary-button compact-button" disabled={!item.prompt.trim()} onClick={() => void runStoryboardAction(() => enqueueVideo(item, Boolean(item.videoPath), activeJobs.length > 0))}><RotateCcw size={15} /> {activeJobs.length > 0 ? "插队" : "重发"}</button>
                    )}
                    <div className="storyboard-card-more-actions">
                      <button className={(item.videoPath || item.imagePaths.length > 0) ? "icon-button has-media" : "icon-button"} title={item.videoPath ?? latestImagePath(item) ?? "选择画面素材"} disabled={fileBusy !== null} onClick={() => void selectVisual(item)}><ImagePlus size={16} /></button>
                      <button className="icon-button danger" title="删除分镜" onClick={() => void remove(item)}><Trash2 size={16} /></button>
                    </div>
                  </div>
                </article>
              );
            })}
            {storyboards.length === 0 && <div className="table-empty"><button className="primary-button" disabled={fileBusy !== null} onClick={() => void importCsv()}><TableProperties size={17} /> 导入 CSV</button></div>}
          </div>
        </section>

        <aside className="automation-sidebar">
          <div className="automation-project-files">
            <strong className="automation-project-name">{project.name}</strong>
            <span title={project.subtitlePath || ""}>字幕 {project.subtitlePath ? shortPath(project.subtitlePath) : "未选择"}</span>
            <span title={project.audioPath || ""}>音频 {project.audioPath ? shortPath(project.audioPath) : "未选择"}</span>
          </div>

          <section className="automation-section character-profile-section">
            <div className="automation-section-heading">
              <h3>角色与场景资产 ({assetCount})</h3>
              <button className="icon-button compact" title="打开资产图文件夹" disabled={fileBusy !== null || !project.folderPath} onClick={() => void openAssetFolder()}><FolderOpen size={15} /></button>
            </div>
            {assetCount === 0 ? (
              <span className="provider-indicator">尚未生成角色表</span>
            ) : (
              <div className="character-profile-list">
                {characterProfiles.map((profile) => (
                  <details key={profile.id}>
                    <summary>
                      <strong>{profile.name}</strong>
                      <span>{profile.assetType === "character" ? "人物" : profile.assetType === "scene" ? "场景" : "特殊空间"}</span>
                    </summary>
                    {profile.assetType === "character" && (
                      <dl>
                        <div><dt>定位</dt><dd>{[profile.identity, profile.gender, profile.age].filter(Boolean).join(" · ") || "未标注"}</dd></div>
                        <div><dt>外观</dt><dd>{profile.appearance || "未单独拆分"}</dd></div>
                        <div><dt>发型</dt><dd>{profile.hair || "未单独拆分"}</dd></div>
                        <div><dt>服装</dt><dd>{profile.clothing || "未单独拆分"}</dd></div>
                        {profile.personality && <div><dt>气质</dt><dd>{profile.personality}</dd></div>}
                      </dl>
                    )}
                    <p>{profile.visualPrompt}</p>
                  </details>
                ))}
                {pendingAssetNames.map((assetName) => (
                  <div className="pending-asset-row" key={`pending-${assetName}`}>
                    <strong>{assetName}</strong>
                    <span>待补设定</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="automation-section">
            <button className="secondary-button full-width" disabled={fileBusy !== null || storyboards.length === 0} onClick={() => void exportJianying()}><Clapperboard size={16} /> 导出到剪映</button>
            <label className="toggle-row automation-clip-toggle"><span>自动剪辑</span><input type="checkbox" checked={autoClip} onChange={(event) => { setAutoClip(event.target.checked); void persistAutomationOption(`project_${project.id}_auto_clip`, String(event.target.checked)); }} /></label>
          </section>

          <section className="automation-section">
            <label className="toggle-row"><span>Q2 积分</span><input type="checkbox" checked={useCredits} onChange={(event) => { setUseCredits(event.target.checked); void persistAutomationOption("vidu_use_credits", String(event.target.checked)); }} /></label>
            <label className="toggle-row"><span>Q3 前置</span><input type="checkbox" checked={preferQ3} onChange={(event) => { const checked = event.target.checked; setPreferQ3(checked); const model = checked ? "Q3" : "Q2"; setViduModel(model); void Promise.all([persistAutomationOption("vidu_model", model), persistAutomationOption(`project_${project.id}_vidu_q3_enabled`, String(checked))]); }} /></label>
            {preferQ3 && <label className="q3-pre-count-row"><span>前</span><input type="number" min={0} max={9999} value={q3PreCount} onChange={(event) => { const count = Math.min(9_999, Math.max(0, Math.trunc(Number(event.target.value) || 0))); setQ3PreCount(count); void persistAutomationOption(`project_${project.id}_vidu_q3_pre_count`, String(count)); }} /><span>个用 Q3</span><small>{q3PreCount === 0 ? "全程 Q3" : `#${q3PreCount} 后转 Q2`}</small></label>}
            <label className="automation-field"><span>生成模型</span><select value={viduModel} onChange={(event) => { const model = event.target.value as ViduModel; const q3Enabled = model === "Q3"; setViduModel(model); setPreferQ3(q3Enabled); void Promise.all([persistAutomationOption("vidu_model", model), persistAutomationOption(`project_${project.id}_vidu_q3_enabled`, String(q3Enabled))]); }}><option value="Q3">Vidu Q3</option><option value="Q2">Vidu Q2</option></select></label>
            <label className="automation-field"><span>宽高比</span><select value={aspectRatio} onChange={(event) => { setAspectRatio(event.target.value); void persistAutomationOption("video_aspect_ratio", event.target.value); }}><option value="16:9">16:9 横屏</option><option value="9:16">9:16 竖屏</option><option value="1:1">1:1 方形</option><option value="4:3">4:3</option><option value="3:4">3:4</option></select></label>
            <div className="provider-indicator">{provider === "vidu-browser" ? "Vidu 浏览器账号" : "自定义视频 API"}</div>
          </section>

          <section className="automation-section automation-controls">
            <h3>自动化控制</h3>
            <button className="primary-button full-width automation-start" disabled={busy || !hasVideoAccount || runnable.length === 0} onClick={() => void generateMany(runnable)}><Play size={17} /> 开始生成 ({runnable.length})</button>
            <div className="automation-control-row">
              <button className="icon-button" title="暂停全部" disabled={!activeJobs.some((job) => job.status !== "paused")} onClick={() => void pauseAll()}><Pause size={16} /></button>
              <button className="icon-button" title="继续全部" disabled={!activeJobs.some((job) => job.status === "paused")} onClick={() => void resumeAll()}><Play size={16} /></button>
              <button className="icon-button danger" title="强制停止全部" disabled={activeJobs.length === 0} onClick={() => void stopAll()}><Square size={15} /></button>
              <button className="icon-button" title="一键检查" disabled={checkableStoryboards.length === 0} onClick={() => void checkAll()}><RefreshCw size={16} /></button>
            </div>
            <button className="secondary-button danger-outline full-width" disabled={busy || storyboards.length === 0 || activeJobs.length > 0} onClick={() => setShowResetConfirmation(true)}><RotateCcw size={16} /> 清空重来</button>
          </section>

          <section className="automation-section automation-overview">
            <h3>概览</h3>
            <div className="sent-count"><span>已发送</span><strong>{stats.sent}</strong><span>次</span></div>
            <div className="sent-progress-row">
              <div className="sent-progress-track" aria-label={`项目完成进度 ${completionPercent}%`}><i style={{ width: `${completionPercent}%` }} /></div>
              <strong>{completionPercent}%</strong>
            </div>
            <div className="overview-status-counts" aria-label="项目任务统计">
              <span className="done">✓ {stats.done}</span>
              <span className="active">↻ {stats.active}</span>
              <span className="error">× {stats.errors}</span>
              <span>共 {stats.total}</span>
            </div>
            {failureGroups.length > 0 && (
              <div className="failure-summary" role="status">
                <strong>失败原因</strong>
                {failureGroups.slice(0, 4).map((group) => (
                  <div key={group.reason} title={`${group.reason} · 分镜 ${group.storyboards.join("、")}`}>
                    <span>{group.count} 条</span>
                    <p>{group.reason}</p>
                  </div>
                ))}
                {failureGroups.length > 4 && <small>另有 {failureGroups.length - 4} 类错误，请查看对应分镜状态</small>}
              </div>
            )}
            <div className="account-pool-summary">
              <span className="account-pool-label" title="本地任务额度估算；网站实时积分请在设置中检查账号">本地账号任务额度</span>
              {accountPool.enabledCount > 0 ? (
                <>
                  <div className="account-pool-headline"><strong>{accountPool.used}<small> / {accountPool.total}</small></strong><span>剩余 {accountPool.remaining}</span></div>
                  <div className="account-pool-track" aria-label={`账号额度已使用 ${accountPool.percent}%`}><i style={{ width: `${accountPool.percent}%` }} /></div>
                  {accountPool.issues.length > 0 && <div className="account-pool-issues">{accountPool.issues.map((account) => <span key={account.id} title={account.disabledMessage || account.disabledReason || "账号已禁用"}>{account.name} · {account.disabledReason === "credits_exhausted" ? "额度用尽" : account.disabledReason === "subject_limit" ? "主体受限" : account.disabledReason === "login_expired" ? "登录失效" : "已禁用"}</span>)}</div>}
                </>
              ) : <span className="account-pool-empty">暂无账号，请到设置添加</span>}
            </div>
          </section>

          <div className="automation-footer"><ListChecks size={15} /> {selectedIds.size > 0 ? `已选择 ${selectedIds.size} 条` : "可勾选分镜批量处理"}</div>
        </aside>
      </div>

      <ModalDialog
        open={editingStoryboard !== null}
        title={editingStoryboard ? `编辑分镜 #${editingStoryboard.index + 1}` : "编辑分镜"}
        description="生成中的分镜不可修改；保存后后续任务会使用新内容。"
        busy={busy}
        onClose={() => setEditingStoryboard(null)}
        actions={(
          <>
            <button className="secondary-button" disabled={busy} onClick={() => setEditingStoryboard(null)}>取消</button>
            <button className="primary-button" disabled={busy || !editPrompt.trim()} onClick={() => void saveStoryboardEdit()}>保存</button>
          </>
        )}
      >
        <div className="storyboard-edit-form">
          <label><span>原文</span><textarea value={editOriginalText} onChange={(event) => setEditOriginalText(event.target.value)} rows={4} /></label>
          <label><span>画面提示词</span><textarea autoFocus value={editPrompt} onChange={(event) => setEditPrompt(event.target.value)} rows={6} /></label>
          <label className="storyboard-edit-duration"><span>时长（秒）</span><input type="number" min={1} max={600} value={editDuration} onChange={(event) => setEditDuration(event.target.value)} /></label>
        </div>
      </ModalDialog>

      <ModalDialog
        open={showResetConfirmation}
        title="清空重来"
        description="清空全部生成状态并将所有分镜重置为待生成。本地图片、视频和原始素材文件会保留。"
        busy={busy}
        onClose={() => { if (!busy) setShowResetConfirmation(false); }}
        actions={(
          <>
            <button className="secondary-button" disabled={busy} onClick={() => setShowResetConfirmation(false)}>取消</button>
            <button className="danger-button" disabled={busy} onClick={() => void resetProject()}><RotateCcw size={15} /> 确认清空</button>
          </>
        )}
      >
        <div className="storyboard-delete-summary">
          <strong>{project.name}</strong>
          <p>将重置 {storyboards.length} 个分镜，并删除对应的本地任务历史。</p>
          <small>提交中或已有远端任务 ID 的分镜仍会被保护；失败和待确认状态可以清空。</small>
        </div>
      </ModalDialog>

      <ModalDialog
        open={uncertainStoryboard !== null}
        title={uncertainStoryboard ? `确认 Vidu 任务 · 分镜 #${uncertainStoryboard.index + 1}` : "确认 Vidu 任务"}
        description={deleteAfterUncertainClear
          ? "提交结果不确定，必须先核对 Vidu 网站任务历史，不能直接删除。"
          : "提交阶段曾中断，程序不会自动重发，以免重复扣除积分。"}
        busy={busy}
        onClose={() => {
          setUncertainStoryboard(null);
          setUncertainTaskId("");
          setUncertainClearConfirmed(false);
          setDeleteAfterUncertainClear(false);
        }}
        actions={(
          <>
            <button className="secondary-button" disabled={busy} onClick={() => setUncertainStoryboard(null)}>取消</button>
            <button className="danger-button" disabled={busy || !uncertainClearConfirmed} onClick={() => void clearUncertainSubmission()}>
              确认无此任务并清除
            </button>
            <button className="primary-button" disabled={busy || !uncertainTaskId.trim()} onClick={() => void bindUncertainTask()}>
              <Link2 size={15} /> 绑定并恢复检查
            </button>
          </>
        )}
      >
        {uncertainStoryboard && (
          <div className="uncertain-resolution-form">
            <div className="uncertain-storyboard-summary">
              <strong>分镜 #{uncertainStoryboard.index + 1}</strong>
              <p>{uncertainStoryboard.originalText || uncertainStoryboard.prompt || "未填写分镜内容"}</p>
              <small>当前状态：待人工确认 Vidu 提交结果</small>
            </div>
            <label>
              <span>Vidu 网站任务 ID</span>
              <input
                autoFocus
                value={uncertainTaskId}
                onChange={(event) => setUncertainTaskId(event.target.value)}
                placeholder="在 Vidu 网站任务详情或历史记录中复制 task ID"
              />
              <small>找到对应任务时输入 ID，程序会绑定原任务并继续检查，不会重复提交。</small>
            </label>
            <label className="uncertain-clear-confirmation">
              <input
                type="checkbox"
                checked={uncertainClearConfirmed}
                onChange={(event) => setUncertainClearConfirmed(event.target.checked)}
              />
              <span>我已检查 Vidu 网站任务历史，确认没有这次任务；允许清除待确认状态。</span>
            </label>
          </div>
        )}
      </ModalDialog>

      <ModalDialog
        open={deletingStoryboard !== null}
        title={deletingStoryboard ? `删除分镜 #${deletingStoryboard.index + 1}` : "删除分镜"}
        description={forceDeleteTrackedVideo
          ? "该分镜仍在跟踪视频任务。继续会停止本地跟踪并删除分镜，但不会删除 Vidu 网站上的任务。"
          : "此操作会删除该分镜的本地记录，不会删除项目目录中的原始素材。"}
        busy={busy}
        onClose={() => { setDeletingStoryboard(null); setForceDeleteTrackedVideo(false); }}
        actions={(
          <>
            <button className="secondary-button" disabled={busy} onClick={() => { setDeletingStoryboard(null); setForceDeleteTrackedVideo(false); }}>取消</button>
            <button className="danger-button" disabled={busy} onClick={() => void confirmStoryboardDeletion()}><Trash2 size={15} /> {forceDeleteTrackedVideo ? "停止跟踪并删除" : "删除"}</button>
          </>
        )}
      >
        {deletingStoryboard && (
          <div className="storyboard-delete-summary">
            <strong>分镜 #{deletingStoryboard.index + 1}</strong>
            <p>{deletingStoryboard.originalText || deletingStoryboard.prompt || "未填写分镜内容"}</p>
            <small>{forceDeleteTrackedVideo
              ? "删除后程序不会自动检查或下载该网站任务的结果；网站任务可能仍会继续生成。"
              : "确认删除前，程序会再次检查是否仍有排队、运行或暂停中的任务。"}</small>
          </div>
        )}
      </ModalDialog>
    </div>
  );
}
