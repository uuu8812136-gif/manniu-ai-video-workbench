import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";
import {
  CheckCircle2,
  Copy,
  Download,
  FileInput,
  FileText,
  FolderOpen,
  Link2,
  Play,
  RotateCcw,
  Settings,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type {
  ImportedDocumentFile,
  Project,
  Storyboard,
  WorkflowJob,
  WorkflowJobEvent,
} from "../../../shared/contracts";
import {
  canRetryWorkflowJob,
  canStopWorkflowJob,
  childDirectory,
  fileStem,
  mergeTrackedWorkflowJobs,
  nonWhitespaceLength,
  parseOpeningResult,
  polishDocumentPickerInput,
  polishDocumentSelectionError,
  polishInputValidationError,
  recoveryWorkDirectory,
  restoreSingleTextWorkflow,
  resolveWorkflowOutputDirectory,
  safeWindowsName,
  singleTextWorkflowStorageKey,
  textOutputName,
  type PolishWorkbenchMode,
} from "./text-workbench-state";
import {
  cancelledInferenceTaskIds,
  inferenceStageLabel,
  latestInferencePauseDiagnostics,
  latestInferenceProgressDetail,
  restoreInferenceTasks,
  useInferenceWorkbenchStore,
  type InferenceSource,
  type InferenceTask,
} from "./inference-workbench-state";

type Kind = "opening" | "polish" | "inference";
type SingleKind = Exclude<Kind, "inference">;
type OpeningMode = "general" | "enhanced";
type OpeningInputMode = "qq" | "file" | "paste";

const copy = {
  opening: { title: "开头优化", subtitle: "生成并比较多个故事开场", action: "生成开头", fileSuffix: "开头优化" },
  polish: { title: "捋文", subtitle: "整理适合配音的完整文案", action: "开始捋文", fileSuffix: "捋文" },
} as const;

const inferenceGenres = [
  ["auto", "自动判断"],
  ["玄幻", "玄幻/修真"],
  ["都市", "都市"],
  ["历史", "历史"],
  ["现实", "现实"],
] as const;

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function staleDesktopBridgeError(): Error {
  return new Error("界面已更新，但桌面程序接口仍是旧版本。请完全退出 AI工具后重新打开。");
}

async function pickMultipleDocuments(): Promise<ImportedDocumentFile[]> {
  const picker = window.offline.files.pickDocuments;
  if (typeof picker !== "function") throw staleDesktopBridgeError();
  return picker({ multiple: true });
}

async function readDroppedDocuments(files: readonly File[]): Promise<ImportedDocumentFile[]> {
  const importer = window.offline.files.importDroppedDocuments;
  if (typeof importer !== "function") throw staleDesktopBridgeError();
  return importer(files);
}

function dragHasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function outputText(job: WorkflowJob | null): string {
  if (!job?.output || typeof job.output !== "object") return "";
  const text = (job.output as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function workflowOutputPath(job: WorkflowJob | null): string {
  if (!job?.output || typeof job.output !== "object") return "";
  const outputPath = (job.output as { outputPath?: unknown }).outputPath;
  return typeof outputPath === "string" ? outputPath : "";
}

function outputStoryboards(job: WorkflowJob | null): Storyboard[] {
  if (!job?.output || typeof job.output !== "object") return [];
  const storyboards = (job.output as { storyboards?: unknown }).storyboards;
  return Array.isArray(storyboards) ? storyboards as Storyboard[] : [];
}

function progressMessage(events: WorkflowJobEvent[]): string | null {
  return latestInferenceProgressDetail(events) || null;
}

function stageFor(job: WorkflowJob, events: WorkflowJobEvent[] = []): string {
  if (job.status === "done") return "处理完成";
  if (job.status === "error") return "校验未通过，待修复";
  if (job.status === "cancelled") return "已停止";
  if (job.status === "paused") return "已暂停";
  return inferenceStageLabel(progressMessage(events) ?? (job.status === "queued" ? "排队中：等待生成引擎接手" : "准备中"));
}

function statusLabel(job: WorkflowJob | null, initializing = false, stopped = false): string {
  if (initializing) return "准备中";
  if (stopped) return "已停止";
  if (!job) return "失败";
  return {
    queued: "排队中",
    running: "生成中",
    paused: "已暂停",
    done: "完成",
    error: "待修复",
    cancelled: "已停止",
  }[job.status];
}

function useOutputDirectory(settingKey: string, defaultFolder?: string): {
  outputDirectory: string;
  chooseOutputDirectory(): Promise<void>;
  openOutputDirectory(): Promise<void>;
} {
  const [outputDirectory, setOutputDirectory] = useState("");

  useEffect(() => {
    void Promise.all([window.offline.settings.get(settingKey), window.offline.app.paths()])
      .then(([saved, paths]) => setOutputDirectory(resolveWorkflowOutputDirectory(saved, paths.documents, defaultFolder)))
      .catch(() => undefined);
  }, [defaultFolder, settingKey]);

  const chooseOutputDirectory = async (): Promise<void> => {
    const path = await window.offline.files.pickDirectory("选择输出目录");
    if (!path) return;
    setOutputDirectory(path);
    await window.offline.settings.set(settingKey, path);
  };

  const openOutputDirectory = async (): Promise<void> => {
    if (outputDirectory) await window.offline.files.openPath(outputDirectory);
  };

  return { outputDirectory, chooseOutputDirectory, openOutputDirectory };
}

function SingleTextWorkflow({ kind, onOpenSettings }: { kind: SingleKind; onOpenSettings(): void }): ReactElement {
  const labels = copy[kind];
  const outputSettingKey = kind === "opening" ? "opening_output_dir" : "text_polish_output_dir";
  const { outputDirectory, chooseOutputDirectory, openOutputDirectory } = useOutputDirectory(
    outputSettingKey,
    kind === "polish" ? "AI工具捋文" : undefined,
  );
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [editableResult, setEditableResult] = useState("");
  const [openingMode, setOpeningMode] = useState<OpeningMode>("general");
  const [polishMode, setPolishMode] = useState<PolishWorkbenchMode>("original");
  const [polishSourceFormat, setPolishSourceFormat] = useState<"txt" | "docx" | null>(null);
  const [inputMode, setInputMode] = useState<OpeningInputMode>("qq");
  const [qqUrl, setQqUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [job, setJob] = useState<WorkflowJob | null>(null);
  const [stage, setStage] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const autoSavedJobs = useRef(new Set<string>());
  const dragDepth = useRef(0);
  const trackingKey = singleTextWorkflowStorageKey(kind);
  const running = canStopWorkflowJob(job);
  const sourceCount = useMemo(() => nonWhitespaceLength(text), [text]);
  const resultCount = useMemo(() => nonWhitespaceLength(editableResult), [editableResult]);
  const parsedOpenings = useMemo(
    () => kind === "opening" ? parseOpeningResult(editableResult) : null,
    [editableResult, kind],
  );

  useEffect(() => {
    let disposed = false;
    void window.offline.jobs.list().then((jobs) => {
      if (disposed) return;
      const restored = restoreSingleTextWorkflow(kind, jobs, window.localStorage.getItem(trackingKey));
      if (!restored) return;
      window.localStorage.setItem(trackingKey, restored.job.id);
      setJob(restored.job);
      setText(restored.text);
      setTitle(restored.title);
      setOpeningMode(restored.openingMode);
      setPolishMode(restored.polishMode);
      setPolishSourceFormat(restored.polishSourceFormat);
      setStage(stageFor(restored.job));
      const persistedPath = workflowOutputPath(restored.job);
      if (persistedPath) setOutputPath(persistedPath);
    }).catch((reason) => {
      if (!disposed) setError(`恢复上次任务失败：${errorText(reason)}`);
    });
    return () => { disposed = true; };
  }, [kind, trackingKey]);

  useEffect(() => {
    if (!job || !canStopWorkflowJob(job)) return;
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const [jobs, events] = await Promise.all([window.offline.jobs.list(), window.offline.jobs.events(job.id)]);
        const current = jobs.find((item) => item.id === job.id);
        if (!disposed && current) {
          setJob(current);
          setStage(stageFor(current, events));
        }
      } catch (reason) {
        if (!disposed) setError(errorText(reason));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status]);

  useEffect(() => {
    const value = outputText(job);
    if (!value || job?.status !== "done") return;
    setEditableResult(value);
    const persistedPath = workflowOutputPath(job);
    if (persistedPath) {
      setOutputPath(persistedPath);
      setNotice(`结果已保存：${persistedPath}`);
      return;
    }
    if (!outputDirectory || autoSavedJobs.current.has(job.id)) return;
    autoSavedJobs.current.add(job.id);
    void window.offline.files.writeText({
      directory: outputDirectory,
      defaultName: textOutputName(title, labels.fileSuffix),
      text: value,
    }).then((path) => {
      setOutputPath(path);
      setNotice(`结果已保存：${path}`);
    }).catch((reason) => setError(`自动保存失败：${errorText(reason)}`));
  }, [job?.id, job?.status, job?.output, labels.fileSuffix, outputDirectory, title]);

  const resetResult = (): void => {
    window.localStorage.removeItem(trackingKey);
    setJob(null);
    setEditableResult("");
    setOutputPath("");
    setStage("");
  };

  const loadDocument = (document: ImportedDocumentFile): void => {
    if (kind === "opening") setInputMode("file");
    if (kind === "polish") setPolishSourceFormat(document.format);
    setText(document.text);
    setTitle(fileStem(document.path));
    resetResult();
    setNotice(`已读取 ${document.format.toUpperCase()}：${document.path}`);
  };

  const importDocument = async (): Promise<void> => {
    if (running) return;
    setError("");
    try {
      const document = kind === "polish"
        ? (await window.offline.files.pickDocuments(polishDocumentPickerInput(polishMode)))[0]
        : await window.offline.files.pickDocument();
      if (kind === "polish" && document) {
        const validationError = polishDocumentSelectionError(polishMode, [document]);
        if (validationError) return setError(validationError);
      }
      if (document) loadDocument(document);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const importDroppedDocument = async (files: readonly File[]): Promise<void> => {
    if (running || files.length === 0) return;
    setError("");
    try {
      if (kind === "polish") {
        const validationError = polishDocumentSelectionError(polishMode, files);
        if (validationError) return setError(validationError);
      }
      const selectedFiles = kind === "polish" && polishMode === "original" ? files : files.slice(0, 1);
      const [document] = await readDroppedDocuments(selectedFiles);
      if (kind === "polish" && document) {
        const validationError = polishDocumentSelectionError(polishMode, [document]);
        if (validationError) return setError(validationError);
      }
      if (document) loadDocument(document);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const onDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (running || !dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };

  const onDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (!dragHasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    if (running || !dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    void importDroppedDocument(Array.from(event.dataTransfer.files));
  };

  const fetchQq = async (): Promise<void> => {
    if (!qqUrl.trim() || fetching || running) return;
    setFetching(true);
    setError("");
    setNotice("");
    try {
      const source = await window.offline.files.fetchQqNovel(qqUrl.trim());
      setText(source.text);
      setTitle(source.title);
      resetResult();
      setNotice(`已抓取《${source.title}》，共 ${nonWhitespaceLength(source.text).toLocaleString("zh-CN")} 字`);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setFetching(false);
    }
  };

  const run = async (): Promise<void> => {
    if (!text.trim() || running) return;
    if (kind === "polish") {
      const validationError = polishInputValidationError(polishMode, polishSourceFormat);
      if (validationError) return setError(validationError);
    }
    if (!outputDirectory) {
      setError("请先选择输出目录");
      return;
    }
    setError("");
    setNotice("");
    setEditableResult("");
    setOutputPath("");
    try {
      const queued = kind === "opening"
        ? await window.offline.jobs.enqueue("opening.optimize", { text, title, mode: openingMode, outDir: outputDirectory })
        : await window.offline.jobs.enqueue("text.polish", {
            text,
            title,
            outDir: outputDirectory,
            mode: polishMode,
            ...(polishSourceFormat ? { sourceFormat: polishSourceFormat } : {}),
          });
      window.localStorage.setItem(trackingKey, queued.id);
      setJob(queued);
      setStage("排队中：等待生成引擎接手");
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const cancel = async (): Promise<void> => {
    if (!job || !canStopWorkflowJob(job)) return;
    try {
      setJob(await window.offline.jobs.cancel(job.id));
      setStage("已停止");
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const retry = async (): Promise<void> => {
    if (!job) return;
    setError("");
    setEditableResult("");
    setOutputPath("");
    try {
      const queued = job.status === "error"
        ? await window.offline.jobs.retry(job.id)
        : kind === "opening"
          ? await window.offline.jobs.enqueue("opening.optimize", { text, title, mode: openingMode, outDir: outputDirectory })
          : await window.offline.jobs.enqueue("text.polish", {
              text,
              title,
              outDir: outputDirectory,
              mode: polishMode,
              ...(polishSourceFormat ? { sourceFormat: polishSourceFormat } : {}),
            });
      window.localStorage.setItem(trackingKey, queued.id);
      setJob(queued);
      setStage("排队中：等待生成引擎接手");
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const exportResult = async (): Promise<void> => {
    if (!editableResult.trim() || !outputDirectory) return;
    try {
      const path = await window.offline.files.writeText({
        directory: outputDirectory,
        defaultName: textOutputName(title, labels.fileSuffix),
        text: editableResult,
      });
      setOutputPath(path);
      setNotice(`TXT 已导出：${path}`);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const clear = (): void => {
    setText("");
    setTitle("");
    setQqUrl("");
    setPolishSourceFormat(null);
    resetResult();
    setNotice("");
    setError("");
  };

  const changePolishMode = (mode: PolishWorkbenchMode): void => {
    if (running || kind !== "polish") return;
    setPolishMode(mode);
    setError("");
    setDragActive(false);
    dragDepth.current = 0;
    if (mode === "original" && polishSourceFormat !== "txt") clear();
  };

  const polishInputError = kind === "polish" ? polishInputValidationError(polishMode, polishSourceFormat) : null;

  return (
    <div className="page-shell text-workflow-page">
      <header className="page-header">
        <div><h1>{labels.title}</h1><p>{labels.subtitle}</p></div>
        <div className="workflow-actions">
          <button className="icon-button" title={`打开${labels.title}设置`} onClick={onOpenSettings}><Settings size={17} /></button>
          <button className="secondary-button" title={outputDirectory || "选择输出目录"} onClick={() => void chooseOutputDirectory()}><FolderOpen size={17} /> {outputDirectory ? "更换输出目录" : "选择输出目录"}</button>
          {outputDirectory && <button className="icon-button" title="打开输出目录" onClick={() => void openOutputDirectory()}><FolderOpen size={17} /></button>}
          {canRetryWorkflowJob(job) && <button className="secondary-button" onClick={() => void retry()}><RotateCcw size={17} /> 重试</button>}
          {running
            ? <button className="danger-button" onClick={() => void cancel()}><Square size={16} /> 停止</button>
            : <button className="primary-button" disabled={!text.trim() || fetching || Boolean(polishInputError)} onClick={() => void run()}><Play size={17} /> {labels.action}</button>}
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}
      {job?.error && <div className="error-banner">{job.error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      <div className="workflow-grid text-workbench-grid">
        <section
          className={`editor-pane text-document-drop-zone${dragActive ? " drag-active" : ""}`}
          onDragEnter={onDragEnter}
          onDragOver={(event) => { if (dragHasFiles(event) && !running) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {dragActive && <div className="text-document-drop-overlay"><FileInput size={30} /><strong>{kind === "polish" && polishMode === "original" ? "松开导入单个 TXT" : "松开导入 TXT/DOCX"}</strong></div>}
          <div className="pane-toolbar"><strong>输入文案</strong><span>{sourceCount.toLocaleString("zh-CN")} 字</span></div>
          <div className="text-workbench-fields">
            {kind === "opening" && (
              <>
                <label><span>开头模式</span><div className="segmented-control compact">
                  <button className={openingMode === "general" ? "selected" : ""} disabled={running} onClick={() => setOpeningMode("general")}>通用版</button>
                  <button className={openingMode === "enhanced" ? "selected" : ""} disabled={running} onClick={() => setOpeningMode("enhanced")}>增强版</button>
                </div></label>
                <label><span>输入方式</span><div className="segmented-control three compact">
                  <button className={inputMode === "qq" ? "selected" : ""} disabled={running} onClick={() => setInputMode("qq")}><Link2 size={14} /> QQ 阅读</button>
                  <button className={inputMode === "file" ? "selected" : ""} disabled={running} onClick={() => setInputMode("file")}><FileInput size={14} /> 文件</button>
                  <button className={inputMode === "paste" ? "selected" : ""} disabled={running} onClick={() => setInputMode("paste")}><FileText size={14} /> 粘贴</button>
                </div></label>
              </>
            )}
            {kind === "polish" && (
              <label><span>工作模式</span><div className="segmented-control compact">
                <button className={polishMode === "original" ? "selected" : ""} disabled={running} onClick={() => changePolishMode("original")}>原版模式</button>
                <button className={polishMode === "advanced" ? "selected" : ""} disabled={running} onClick={() => changePolishMode("advanced")}>高级模式</button>
              </div></label>
            )}
            {kind === "opening" && inputMode === "qq" && (
              <label><span>QQ 阅读链接</span><div className="text-workbench-inline-input"><input value={qqUrl} disabled={running || fetching} placeholder="https://book.qq.com/book-detail/..." onChange={(event) => setQqUrl(event.target.value)} /><button className="secondary-button" disabled={!qqUrl.trim() || fetching || running} onClick={() => void fetchQq()}>{fetching ? "抓取中" : "抓取"}</button></div></label>
            )}
            <label><span>{kind === "opening" ? "书名" : "文件名称"}</span><input value={title} disabled={running} placeholder="默认使用导入文件名" onChange={(event) => setTitle(event.target.value)} /></label>
            {(kind === "polish" || inputMode === "file") && <button className="secondary-button text-workbench-import" disabled={running} onClick={() => void importDocument()}><FileInput size={17} /> {kind === "polish" && polishMode === "original" ? "选择 TXT" : "选择 TXT/DOCX"}</button>}
            <div className={outputDirectory ? "text-workbench-output-dir" : "text-workbench-output-dir empty"} title={outputDirectory}>输出目录：{outputDirectory || "未选择"}</div>
          </div>
          <textarea
            className="document-editor"
            value={text}
            onChange={(event) => { setText(event.target.value); if (kind === "polish") setPolishSourceFormat(null); resetResult(); }}
            onPaste={(event) => {
              if (kind === "polish" && polishMode === "original") {
                event.preventDefault();
                setError("原版模式不支持粘贴，请导入单个 TXT 文件");
              }
            }}
            placeholder={kind === "polish" && polishMode === "original" ? "请导入单个 TXT 文件" : "输入、粘贴或导入文案"}
            readOnly={kind === "polish" && polishMode === "original"}
            disabled={running}
          />
          <div className="text-workbench-source-actions"><button className="secondary-button" disabled={running || (!text && !title)} onClick={clear}><Trash2 size={16} /> 清空</button></div>
        </section>

        <section className="result-pane">
          <div className="pane-toolbar">
            <strong>处理结果</strong>
            <div className="text-workbench-result-actions">
              {editableResult && <span>{kind === "polish" ? `原文 ${sourceCount.toLocaleString("zh-CN")} 字 · 捋文 ${resultCount.toLocaleString("zh-CN")} 字` : `${resultCount.toLocaleString("zh-CN")} 字`}</span>}
              <button className="icon-button" title="复制结果" disabled={!editableResult} onClick={() => void navigator.clipboard.writeText(editableResult).then(() => setNotice("结果已复制到剪贴板"))}><Copy size={16} /></button>
              <button className="icon-button" title="导出 TXT" disabled={!editableResult || !outputDirectory} onClick={() => void exportResult()}><Download size={16} /></button>
              {outputPath && <button className="icon-button" title="打开输出目录" onClick={() => void openOutputDirectory()}><FolderOpen size={16} /></button>}
            </div>
          </div>
          {job && <><div className="job-progress"><div style={{ width: `${job.progress}%` }} /><span>{job.progress}%</span></div><div className="job-progress-detail">{stage || "准备中"}</div></>}

          {kind === "opening" && parsedOpenings && parsedOpenings.openings.length > 0 && job?.status === "done" ? (
            <div className="opening-result-list">
              <div className="opening-result-summary">{parsedOpenings.genre && <span className="opening-genre">{parsedOpenings.genre}</span>}<strong>候选开头 · {parsedOpenings.openings.length} 个</strong></div>
              {parsedOpenings.openings.map((item, index) => (
                <article className={index === 0 ? "best" : ""} key={item.index}>
                  <header><strong>开头 {item.index}</strong>{item.direction && <span>{item.direction}</span>}{item.structure && <span>{item.structure}</span>}{item.score !== null && <b>{item.score} 分</b>}<button className="icon-button" title={`复制开头 ${item.index}`} onClick={() => void navigator.clipboard.writeText(item.text).then(() => setNotice(`开头 ${item.index} 已复制`))}><Copy size={15} /></button></header>
                  <p>{item.text}</p>
                </article>
              ))}
              {parsedOpenings.body && <div className="opening-body-result">
                <div><strong>抓取正文 · {nonWhitespaceLength(parsedOpenings.body).toLocaleString("zh-CN")} 字</strong><button className="icon-button" title="只复制正文" onClick={() => void navigator.clipboard.writeText(parsedOpenings.body).then(() => setNotice("正文已复制到剪贴板"))}><Copy size={15} /></button></div>
                <details><summary>查看正文</summary><pre>{parsedOpenings.body}</pre></details>
              </div>}
            </div>
          ) : (
            <textarea className="document-editor result" value={editableResult} onChange={(event) => { setEditableResult(event.target.value); setOutputPath(""); }} readOnly={job?.status !== "done"} placeholder="结果将在这里显示，完成后可继续编辑" />
          )}
        </section>
      </div>
    </div>
  );
}

function InferenceWorkflow({ onOpenSettings }: { onOpenSettings(): void }): ReactElement {
  const { outputDirectory, chooseOutputDirectory, openOutputDirectory } = useOutputDirectory("infer_output_dir");
  const { sources, setSources, genre, setGenre, tasks, setTasks } = useInferenceWorkbenchStore();
  const [dragActive, setDragActive] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const dragDepth = useRef(0);
  const restoredJobs = useRef(false);
  const activeKey = tasks
    .filter((task) => task.jobId && canStopWorkflowJob(task.job))
    .map((task) => `${task.jobId}:${task.job?.status}`)
    .join("|");
  const running = tasks.some((task) => task.initializing || canStopWorkflowJob(task.job));

  useEffect(() => {
    if (restoredJobs.current) return;
    restoredJobs.current = true;
    let disposed = false;
    void Promise.all([window.offline.jobs.list(), window.offline.projects.list()])
      .then(async ([jobs, projects]) => {
        const recoverable = jobs.filter((job) => job.type === "storyboard.infer" && ["queued", "running", "paused", "error"].includes(job.status));
        const eventEntries = await Promise.all(recoverable.map(async (job) => [job.id, await window.offline.jobs.events(job.id)] as const));
        if (disposed) return;
        const workDirectories = new Map(eventEntries.map(([id, events]) => [id, recoveryWorkDirectory(events)]));
        const diagnostics = new Map(eventEntries.flatMap(([id, events]) => {
          const detail = latestInferencePauseDiagnostics(events);
          return detail ? [[id, detail] as const] : [];
        }));
        const restored = restoreInferenceTasks(recoverable, projects, workDirectories, diagnostics);
        if (restored.length > 0) {
          setTasks((current) => current.length > 0 ? current : restored);
          setNotice(`已恢复 ${restored.length} 个运行中、暂停或待修复任务`);
        }
      })
      .catch((reason) => { if (!disposed) setError(errorText(reason)); });
    return () => { disposed = true; };
  }, [setTasks]);

  useEffect(() => {
    if (!activeKey) return;
    let disposed = false;
    const refresh = async (): Promise<void> => {
      const activeIds = tasks.filter((task) => task.jobId && canStopWorkflowJob(task.job)).map((task) => task.jobId as string);
      try {
        const [jobs, eventEntries] = await Promise.all([
          window.offline.jobs.list(),
          Promise.all(activeIds.map(async (id) => [id, await window.offline.jobs.events(id)] as const)),
        ]);
        if (disposed) return;
        const events = new Map(eventEntries);
        setTasks((current) => mergeTrackedWorkflowJobs(current, jobs).map((task) => {
          const jobEvents = task.job ? events.get(task.job.id) ?? [] : [];
          return {
            ...task,
            stage: task.job ? stageFor(task.job, jobEvents) : task.stage,
            detail: latestInferenceProgressDetail(jobEvents),
            diagnostics: latestInferencePauseDiagnostics(jobEvents) ?? task.diagnostics,
            workDir: recoveryWorkDirectory(jobEvents) || task.workDir,
          };
        }));
      } catch (reason) {
        if (!disposed) setError(errorText(reason));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeKey]);

  const loadSources = (documents: ImportedDocumentFile[]): void => {
    if (documents.length === 0) return;
    const unique = [...new Map(documents.map((document) => [document.path.toLowerCase(), document])).values()];
    setSources(unique.map((document) => ({
        ...document,
        sourceId: crypto.randomUUID(),
        title: safeWindowsName(fileStem(document.path)),
    })));
    setNotice(`已选择 ${unique.length} 个 TXT/DOCX 文案`);
    setTasks([]);
  };

  const pickSources = async (): Promise<void> => {
    if (running) return;
    setError("");
    try {
      loadSources(await pickMultipleDocuments());
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const importDroppedSources = async (files: readonly File[]): Promise<void> => {
    if (running || files.length === 0) return;
    setError("");
    try {
      loadSources(await readDroppedDocuments(files));
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const onDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (running || !dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };

  const onDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (!dragHasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    if (running || !dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    void importDroppedSources(Array.from(event.dataTransfer.files));
  };

  const queueTask = async (task: InferenceTask, existingProject?: Project): Promise<InferenceTask> => {
    try {
      const project = existingProject ?? await window.offline.projects.create({
        name: task.source.title,
        folderPath: childDirectory(outputDirectory, task.source.title),
      });
      if (!existingProject) {
        await window.offline.files.writeText({
          directory: project.folderPath,
          defaultName: textOutputName(task.source.title, "原文"),
          text: task.source.text,
        });
      }
      if (cancelledInferenceTaskIds.has(task.taskId)) {
        return { ...task, project, stage: "已停止", error: "", initializing: false, stopped: true };
      }
      const job = await window.offline.jobs.enqueue("storyboard.infer", {
        text: task.source.text,
        genre: task.genre === "auto" ? undefined : task.genre,
        projectId: project.id,
      });
      if (cancelledInferenceTaskIds.has(task.taskId)) {
        const cancelled = await window.offline.jobs.cancel(job.id);
        return { ...task, project, jobId: job.id, job: cancelled, stage: "已停止", error: "", initializing: false, stopped: true };
      }
      return { ...task, project, jobId: job.id, job, stage: "排队中：等待生成引擎接手", error: "", initializing: false, stopped: false };
    } catch (reason) {
      return { ...task, project: existingProject ?? task.project, stage: "准备失败", error: errorText(reason), initializing: false, stopped: false };
    }
  };

  const runAll = async (): Promise<void> => {
    if (running) return;
    if (sources.length === 0) {
      setError("请先选择 TXT/DOCX 文案");
      return;
    }
    if (!outputDirectory) {
      setError("请先选择输出目录");
      return;
    }
    setError("");
    setNotice("");
    const pending: InferenceTask[] = sources.map((source) => ({
      taskId: crypto.randomUUID(),
      source,
      genre,
      project: null,
      jobId: null,
      job: null,
      stage: "正在创建项目",
      error: "",
      initializing: true,
      stopped: false,
    }));
    setTasks(pending);
    const queued = await Promise.all(pending.map((task) => queueTask(task)));
    setTasks(queued);
    const successCount = queued.filter((task) => task.jobId).length;
    setNotice(`已提交 ${successCount}/${queued.length} 个推理任务`);
  };

  const stopTask = async (task: InferenceTask): Promise<void> => {
    if (!task.job || !canStopWorkflowJob(task.job)) return;
    try {
      const cancelled = await window.offline.jobs.cancel(task.job.id);
      setTasks((current) => current.map((item) => item.taskId === task.taskId
        ? { ...item, job: cancelled, stage: "已停止", stopped: true }
        : item));
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const stopAll = async (): Promise<void> => {
    tasks.filter((task) => task.initializing).forEach((task) => cancelledInferenceTaskIds.add(task.taskId));
    const stoppable = tasks.filter((task) => task.job && canStopWorkflowJob(task.job));
    try {
      const cancelled = await Promise.all(stoppable.map(async (task) => [task.taskId, await window.offline.jobs.cancel(task.job!.id)] as const));
      const byTaskId = new Map(cancelled);
      setTasks((current) => current.map((task) => {
        const job = byTaskId.get(task.taskId);
        if (job) return { ...task, job, stage: "已停止", stopped: true };
        return task.initializing ? { ...task, initializing: false, stage: "已停止", stopped: true } : task;
      }));
      setNotice(`已停止 ${cancelled.length + tasks.filter((task) => task.initializing).length} 个任务`);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const retryTask = async (task: InferenceTask): Promise<void> => {
    setError("");
    cancelledInferenceTaskIds.delete(task.taskId);
    if (task.job?.status === "error" || task.job?.status === "paused") {
      try {
        const job = task.job.status === "paused"
          ? await window.offline.jobs.resume(task.job.id)
          : await window.offline.jobs.retry(task.job.id);
        setTasks((current) => current.map((item) => item.taskId === task.taskId
          ? { ...item, job, jobId: job.id, stage: "排队中：等待生成引擎接手", error: "", stopped: false }
          : item));
      } catch (reason) {
        setError(errorText(reason));
      }
      return;
    }
    setTasks((current) => current.map((item) => item.taskId === task.taskId
      ? { ...item, initializing: true, stage: "正在重新提交", error: "", stopped: false }
      : item));
    const queued = await queueTask({ ...task, initializing: true, error: "" }, task.project ?? undefined);
    setTasks((current) => current.map((item) => item.taskId === task.taskId ? queued : item));
  };

  const openTaskDirectory = async (task: InferenceTask): Promise<void> => {
    const path = task.job?.status === "done" ? task.project?.folderPath : task.workDir || task.project?.folderPath;
    if (!path) return;
    try {
      await window.offline.files.openPath(path);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  return (
    <div className="page-shell text-workflow-page inference-workbench">
      <header className="page-header">
        <div><h1>小说转分镜</h1><p>多文案并行生成角色、提示词和结构化分镜</p></div>
        <div className="workflow-actions">
          <button className="icon-button" title="打开小说转分镜设置" onClick={onOpenSettings}><Settings size={17} /></button>
          <button className="secondary-button" title={outputDirectory || "选择输出目录"} onClick={() => void chooseOutputDirectory()}><FolderOpen size={17} /> {outputDirectory ? "更换输出目录" : "选择输出目录"}</button>
          <button className="icon-button" title="打开输出目录" disabled={!outputDirectory} onClick={() => void openOutputDirectory()}><FolderOpen size={17} /></button>
          {running
            ? <button className="danger-button" onClick={() => void stopAll()}><Square size={16} /> 全部停止</button>
            : <button className="primary-button" disabled={sources.length === 0} onClick={() => void runAll()}><Play size={17} /> 开始生成</button>}
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      <div className="inference-workbench-body">
        <section className="inference-control-panel">
          <label
            className={`inference-drop-target${dragActive ? " drag-active" : ""}`}
            onDragEnter={onDragEnter}
            onDragOver={(event) => { if (dragHasFiles(event) && !running) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          ><span>文案</span><button className="inference-file-picker" disabled={running} onClick={() => void pickSources()}><FileInput size={26} /><strong>{dragActive ? "松开导入文件" : sources.length > 0 ? `已选择 ${sources.length} 个文案` : "选择或拖入多个 TXT/DOCX"}</strong></button></label>
          {sources.length > 0 && <div className="inference-source-list">{sources.map((source) => <div key={source.sourceId}><FileText size={15} /><span title={source.path}>{source.title}</span><small>{nonWhitespaceLength(source.text).toLocaleString("zh-CN")} 字</small><button className="icon-button" title="移除" disabled={running} onClick={() => setSources((current) => current.filter((item) => item.sourceId !== source.sourceId))}><X size={14} /></button></div>)}</div>}
          <label><span>题材</span><select value={genre} disabled={running} onChange={(event) => setGenre(event.target.value)}>{inferenceGenres.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <div className={outputDirectory ? "text-workbench-output-dir" : "text-workbench-output-dir empty"} title={outputDirectory}>输出目录：{outputDirectory || "未选择"}</div>
        </section>

        <section className="inference-task-list">
          {tasks.length === 0 ? (
            <div className="inference-empty"><FileText size={40} /><strong>还没有任务</strong></div>
          ) : tasks.map((task) => {
            const storyboards = outputStoryboards(task.job);
            const resumable = task.job?.status === "paused";
            const retryable = resumable || task.stopped || Boolean(task.error) || canRetryWorkflowJob(task.job);
            const retainedDirectory = task.workDir || task.project?.folderPath || "";
            const hasRetainedDirectory = Boolean(retainedDirectory) && (
              task.stopped || Boolean(task.error) || task.job?.status === "error" || task.job?.status === "paused" || task.job?.status === "cancelled"
            );
            return (
              <article className="inference-task-card" key={task.taskId}>
                <header>
                  <div><FileText size={17} /><strong title={task.source.path}>{task.source.title}</strong><span className={`job-state ${task.job?.status ?? (task.initializing ? "queued" : task.stopped ? "cancelled" : "error")}`}>{statusLabel(task.job, task.initializing, task.stopped)}</span></div>
                  <div className="inference-task-actions">
                    {retryable && <button className="secondary-button" onClick={() => void retryTask(task)}>{resumable ? <><Play size={15} /> 继续</> : <><RotateCcw size={15} /> 重试</>}</button>}
                    {canStopWorkflowJob(task.job) && <button className="danger-button" onClick={() => void stopTask(task)}><Square size={14} /> 停止</button>}
                  </div>
                </header>
                {(task.initializing || task.job) && <><div className="job-progress"><div style={{ width: `${task.job?.progress ?? 2}%` }} /><span>{task.job?.progress ?? 2}%</span></div><div className="job-progress-detail inference-progress-copy"><strong>{task.stage}</strong>{task.detail && task.detail !== task.stage && <small title={task.detail}>{task.detail}</small>}</div></>}
                {(task.error || task.job?.error) && <div className="inference-task-error">{task.error || task.job?.error}</div>}
                {task.diagnostics && <div className="inference-task-diagnostics">
                  <span>阶段：{inferenceStageLabel(task.diagnostics.stage)}</span>
                  <span>错误分类：{task.diagnostics.errorCategory}</span>
                  <span>已完成：{task.diagnostics.completedIndexes.length} 镜{task.diagnostics.completedIndexes.length > 0 ? `，最后镜号 ${task.diagnostics.completedIndexes.at(-1)}` : ""}</span>
                  {task.diagnostics.reportPaths.length > 0 && <span title={task.diagnostics.reportPaths.join("\n")}>诊断报告：{task.diagnostics.reportPaths.length} 个</span>}
                </div>}
                {task.job?.status === "done" && <div className="inference-task-done"><span><CheckCircle2 size={17} /> 角色表 + CSV 已生成，共 {storyboards.length} 个分镜</span><button className="secondary-button" disabled={!task.project?.folderPath} onClick={() => void openTaskDirectory(task)}><FolderOpen size={15} /> 打开目录</button></div>}
                {hasRetainedDirectory && <div className="inference-task-retained"><span title={retainedDirectory}>待修复目录：{retainedDirectory}</span><button className="secondary-button" onClick={() => void openTaskDirectory(task)}><FolderOpen size={15} /> 打开待修复目录</button></div>}
              </article>
            );
          })}
        </section>
      </div>
    </div>
  );
}

export function TextWorkflowPage({ kind, onOpenSettings }: { kind: Kind; onOpenSettings(): void }): ReactElement {
  return kind === "inference"
    ? <InferenceWorkflow key="inference" onOpenSettings={onOpenSettings} />
    : <SingleTextWorkflow key={kind} kind={kind} onOpenSettings={onOpenSettings} />;
}
