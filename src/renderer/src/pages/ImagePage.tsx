import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Eye,
  FolderOpen,
  Image as ImageIcon,
  Images,
  Pencil,
  Play,
  RotateCcw,
  Settings,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { StandaloneImageJobOutput, WorkflowJobStatus } from "../../../shared/contracts";
import { standaloneImageUrl } from "../../../shared/local-media";
import {
  clampImageConcurrency,
  clampImageCount,
  hasConfiguredImageApiKey,
  imageBatchStorageKey,
  imageModelConfig,
  IMAGE_MODEL_CONFIGS,
  normalizeImageSelection,
  normalizeEditedImagePrompt,
  parsePromptBatches,
  restoreStandaloneImageBatch,
  summarizeImageBatchCompletion,
  type ImageWorkbenchResult,
  type ImageWorkbenchResultStatus,
  type ImagePromptBatch,
} from "./image-workbench-state";

type WorkbenchResult = ImageWorkbenchResult;

const statusText: Record<ImageWorkbenchResultStatus, string> = {
  pending: "等待中",
  queued: "排队中",
  running: "生成中",
  paused: "已暂停",
  done: "完成",
  error: "失败",
  cancelled: "已停止",
};

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function imageName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function terminal(status: WorkflowJobStatus): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function createBatchName(): string {
  const now = new Date();
  const part = (value: number): string => String(value).padStart(2, "0");
  return `批量生图-${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
}

function isStandaloneOutput(value: unknown): value is StandaloneImageJobOutput {
  if (!value || typeof value !== "object") return false;
  const output = value as Partial<StandaloneImageJobOutput>;
  return Array.isArray(output.imagePaths)
    && output.imagePaths.every((path) => typeof path === "string")
    && typeof output.outputDirectory === "string";
}

export function ImagePage({ onOpenSettings }: { onOpenSettings(): void }): ReactElement {
  const [promptText, setPromptText] = useState("");
  const [model, setModel] = useState("gpt-image-2");
  const [aspect, setAspect] = useState("16:9");
  const [resolution, setResolution] = useState("1K");
  const [count, setCount] = useState(1);
  const [concurrency, setConcurrency] = useState(3);
  const [outputDirectory, setOutputDirectory] = useState("");
  const [referencePaths, setReferencePaths] = useState<string[]>([]);
  const [results, setResults] = useState<WorkbenchResult[]>([]);
  const [generating, setGenerating] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [apiKeyReady, setApiKeyReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<{ jobId: string; imageIndex: number; version: string } | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<{ key: string; value: string } | null>(null);
  const batchToken = useRef(0);
  const resultsRef = useRef(results);

  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  const parsedPrompts = useMemo(() => parsePromptBatches(promptText), [promptText]);
  const config = imageModelConfig(model);
  const selection = useMemo(() => normalizeImageSelection(model, aspect, resolution), [aspect, model, resolution]);
  const progress = useMemo(() => ({
    done: results.filter((item) => item.status === "done" || item.status === "error" || item.status === "cancelled").length,
    total: results.length,
  }), [results]);

  useEffect(() => {
    void window.offline.settings.list().then((settings) => {
      const nextModel = settings.imagegen_model?.trim() || "gpt-image-2";
      const nextConfig = imageModelConfig(nextModel);
      const normalized = normalizeImageSelection(nextModel);
      setModel(nextModel);
      setOutputDirectory(settings.imagegen_output_dir?.trim() || "");
      setApiKeyReady(hasConfiguredImageApiKey(settings));
      setSettingsLoaded(true);
      setAspect(normalized.aspect);
      setResolution(normalized.resolution);
      setConcurrency(nextConfig.defaultConcurrency);
    }).catch((reason) => {
      setSettingsLoaded(true);
      setApiKeyReady(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, []);

  const setResult = (key: string, patch: Partial<WorkbenchResult>): void => {
    setResults((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
  };

  const selectModel = (nextModel: string): void => {
    const nextConfig = imageModelConfig(nextModel);
    const normalized = normalizeImageSelection(nextModel, aspect, resolution);
    setModel(nextModel);
    setAspect(normalized.aspect);
    setResolution(normalized.resolution);
    setCount((value) => clampImageCount(nextModel, value));
    setConcurrency((value) => Math.min(clampImageConcurrency(nextModel, value), nextConfig.defaultConcurrency));
  };

  const chooseOutputDirectory = async (): Promise<void> => {
    if (generating) return;
    const path = await window.offline.files.pickDirectory("选择独立生图保存目录");
    if (path) setOutputDirectory(path);
  };

  const addReference = async (): Promise<void> => {
    if (referencePaths.length >= 4 || generating) return;
    const path = await window.offline.files.pickFile("visual");
    if (!path) return;
    if (!/\.(?:png|jpe?g|webp)$/i.test(path)) {
      setError("参考图仅支持 PNG、JPEG 和 WebP");
      return;
    }
    setReferencePaths((current) => current.includes(path) ? current : [...current, path].slice(0, 4));
  };

  const prepareResults = (batches: ImagePromptBatch[], batchName: string): WorkbenchResult[] => batches.map((batch, index) => ({
    ...batch,
    key: `${Date.now()}-${index}-${crypto.randomUUID()}`,
    batchName,
    jobId: null,
    status: "pending",
    progress: 0,
    error: null,
    imagePaths: [],
    outputDirectory: "",
    updatedAt: new Date().toISOString(),
  }));

  const waitForJob = async (result: WorkbenchResult, jobId: string, token?: number): Promise<WorkflowJobStatus | null> => {
    for (;;) {
      if (token !== undefined && token !== batchToken.current) return null;
      const jobs = await window.offline.jobs.list();
      const job = jobs.find((item) => item.id === jobId);
      if (!job) throw new Error("独立生图任务不存在");
      const patch: Partial<WorkbenchResult> = {
        status: job.status,
        progress: job.progress,
        error: job.error,
        updatedAt: job.updatedAt,
      };
      if (job.status === "done") {
        if (!isStandaloneOutput(job.output)) throw new Error("独立生图任务返回了无效结果");
        patch.imagePaths = job.output.imagePaths;
        patch.outputDirectory = job.output.outputDirectory;
      }
      setResult(result.key, patch);
      if (terminal(job.status)) return job.status;
      await delay(700);
    }
  };

  const enqueueResult = async (result: WorkbenchResult, token?: number): Promise<WorkflowJobStatus> => {
    try {
      setResult(result.key, { status: "queued", progress: 0, error: null });
      const job = await window.offline.jobs.enqueue("image.standalone", {
        prompt: result.prompt,
        name: result.name,
        batchName: result.batchName,
        ...(outputDirectory ? { outputDirectory } : {}),
        workbenchKey: result.key,
        model,
        count,
        aspectRatio: selection.aspect,
        ...(selection.size ? { size: selection.size } : {}),
        ...(referencePaths.length > 0 ? { referenceImagePaths: referencePaths } : {}),
      });
      setResult(result.key, {
        jobId: job.id,
        status: job.status === "running" ? "running" : "queued",
        progress: job.progress,
        updatedAt: job.updatedAt,
      });
      return await waitForJob(result, job.id, token) ?? "cancelled";
    } catch (reason) {
      setResult(result.key, { status: "error", error: reason instanceof Error ? reason.message : String(reason) });
      return "error";
    }
  };

  useEffect(() => {
    let disposed = false;
    const token = ++batchToken.current;
    void window.offline.jobs.list().then(async (jobs) => {
      if (disposed) return;
      const restored = restoreStandaloneImageBatch(jobs, window.localStorage.getItem(imageBatchStorageKey()));
      if (restored.length === 0) return;
      const batchName = restored[0]!.batchName;
      window.localStorage.setItem(imageBatchStorageKey(), batchName);
      resultsRef.current = restored;
      setResults(restored);
      const active = restored.filter((item) => item.jobId && ["queued", "running", "paused"].includes(item.status));
      if (active.length === 0) return;
      setGenerating(true);
      await Promise.all(active.map((item) => waitForJob(item, item.jobId!, token)));
      if (disposed || token !== batchToken.current) return;
      const refreshed = restoreStandaloneImageBatch(await window.offline.jobs.list(), batchName);
      resultsRef.current = refreshed;
      setResults(refreshed);
      const summary = summarizeImageBatchCompletion(refreshed.map((item) => item.status));
      setNotice(summary.notice ?? "");
      setError(summary.error ?? "");
      setGenerating(false);
    }).catch((reason) => {
      if (!disposed) setError(`恢复上次生图任务失败：${reason instanceof Error ? reason.message : String(reason)}`);
    });
    return () => {
      disposed = true;
      batchToken.current += 1;
    };
  }, []);

  const startBatch = async (): Promise<void> => {
    if (generating || parsedPrompts.length === 0) return;
    if (!apiKeyReady) {
      setError("请先在「设置 → 出图设置」中配置 API Key");
      return;
    }
    setGenerating(true);
    setError("");
    setNotice("");
    const token = ++batchToken.current;
    const batchName = createBatchName();
    const prepared = prepareResults(parsedPrompts, batchName);
    window.localStorage.setItem(imageBatchStorageKey(), batchName);
    resultsRef.current = prepared;
    setResults(prepared);
    try {
      let cursor = 0;
      const outcomes: WorkflowJobStatus[] = [];
      const worker = async (): Promise<void> => {
        while (token === batchToken.current) {
          const result = prepared[cursor++];
          if (!result) return;
          outcomes.push(await enqueueResult(result, token));
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, prepared.length) }, () => worker()));
      if (token === batchToken.current) {
        const summary = summarizeImageBatchCompletion(outcomes);
        setNotice(summary.notice ?? "");
        setError(summary.error ?? "");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (token === batchToken.current) setGenerating(false);
    }
  };

  const stopBatch = async (): Promise<void> => {
    batchToken.current += 1;
    setGenerating(false);
    const active = resultsRef.current.filter((item) => item.jobId && (item.status === "queued" || item.status === "running"));
    await Promise.all(active.map((item) => window.offline.jobs.cancel(item.jobId!).catch(() => undefined)));
    setResults((current) => current.map((item) =>
      item.status === "pending" || item.status === "queued" || item.status === "running"
        ? { ...item, status: "cancelled", error: null }
        : item,
    ));
  };

  const stopOne = async (result: WorkbenchResult): Promise<void> => {
    if (!result.jobId) return;
    await window.offline.jobs.cancel(result.jobId);
    setResult(result.key, { status: "cancelled", error: null });
  };

  const regenerate = async (result: WorkbenchResult): Promise<void> => {
    if (!apiKeyReady) {
      setError("请先在「设置 → 出图设置」中配置 API Key");
      return;
    }
    window.localStorage.setItem(imageBatchStorageKey(), result.batchName);
    await enqueueResult(result);
  };

  const beginPromptEdit = (result: WorkbenchResult): void => {
    setError("");
    setEditingPrompt({ key: result.key, value: result.prompt });
  };

  const savePromptEdit = (result: WorkbenchResult): void => {
    if (editingPrompt?.key !== result.key) return;
    const prompt = normalizeEditedImagePrompt(editingPrompt.value);
    if (!prompt) {
      setError("提示词不能为空");
      return;
    }
    setResult(result.key, { prompt });
    setEditingPrompt(null);
    setError("");
    setNotice(`“${result.name}”提示词已保存`);
  };

  const clearResults = (): void => {
    window.localStorage.removeItem(imageBatchStorageKey());
    resultsRef.current = [];
    setResults([]);
    setNotice("");
    setError("");
    setEditingPrompt(null);
  };

  const openOutputDirectory = async (): Promise<void> => {
    const directory = results.find((item) => item.outputDirectory)?.outputDirectory || outputDirectory;
    if (directory) await window.offline.files.openPath(directory);
  };

  const modelOptions = Array.from(new Set([model, ...Object.keys(IMAGE_MODEL_CONFIGS)]));
  const hasOutputDirectory = Boolean(results.some((item) => item.outputDirectory) || outputDirectory);

  return (
    <div className="page-shell image-workbench-page">
      <header className="page-header image-workbench-header">
        <div><h1>批量出图</h1><p>{progress.total ? `${progress.done}/${progress.total} 条已处理` : `${parsedPrompts.length} 条提示词`}</p></div>
        <div className="workflow-actions">
          <button className="icon-button" title="打开生图设置" onClick={onOpenSettings}><Settings size={17} /></button>
          <button className="icon-button" title="清空本页结果" disabled={generating || results.length === 0} onClick={clearResults}><Trash2 size={17} /></button>
          <button className="secondary-button" disabled={!hasOutputDirectory} onClick={() => void openOutputDirectory()}><FolderOpen size={17} /> 打开保存目录</button>
          {generating
            ? <button className="danger-button" onClick={() => void stopBatch()}><Square size={16} /> 停止</button>
            : <button className="primary-button" disabled={!settingsLoaded || !apiKeyReady || parsedPrompts.length === 0} onClick={() => void startBatch()}><Play size={17} /> 开始生成 ({parsedPrompts.length})</button>}
        </div>
      </header>

      {settingsLoaded && !apiKeyReady && <div className="warning-banner">尚未配置 API Key，请先到「设置 → 出图设置」填写后再生成。</div>}
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      <div className="image-workbench-layout">
        <aside className="image-workbench-controls">
          <label className="image-workbench-project"><span>独立保存目录</span><button className="secondary-button" disabled={generating} title={outputDirectory || "未选择时使用设置中的生图目录"} onClick={() => void chooseOutputDirectory()}><FolderOpen size={16} /> {outputDirectory ? imageName(outputDirectory) : "自动保存"}</button><small title={outputDirectory}>{outputDirectory || "使用设置中的生图目录"}</small></label>

          <label className="image-workbench-prompts"><span>提示词批次</span><textarea rows={15} value={promptText} disabled={generating} placeholder={`角色甲\n红衣少女站在雨中\n###\n角色乙\n白发少年回头`} onChange={(event) => setPromptText(event.target.value)} /><small>{parsedPrompts.length}/100 条</small></label>

          <div className="image-workbench-options">
            <label><span>模型</span><select value={model} disabled={generating} onChange={(event) => selectModel(event.target.value)}>{modelOptions.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
            <label><span>分辨率</span><select value={selection.resolution} disabled={generating} onChange={(event) => setResolution(event.target.value)}>{config.resolutions.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
            <label><span>比例</span><select value={selection.aspect} disabled={generating} onChange={(event) => setAspect(event.target.value)}>{Object.keys(config.sizes).map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
            <label><span>数量/条</span><input type="number" min={1} max={config.maxCount} value={count} disabled={generating} onChange={(event) => setCount(clampImageCount(model, Number(event.target.value)))} /></label>
            <label><span>并发数</span><input type="number" min={1} max={config.maxConcurrency} value={concurrency} disabled={generating} onChange={(event) => setConcurrency(clampImageConcurrency(model, Number(event.target.value)))} /></label>
            <label><span>实际尺寸</span><input value={selection.size || "服务默认"} readOnly /></label>
          </div>

          <div className="image-workbench-references">
            <div><span>参考图</span><button className="secondary-button" disabled={generating || referencePaths.length >= 4} onClick={() => void addReference()}><Images size={16} /> 添加 ({referencePaths.length}/4)</button></div>
            {referencePaths.map((path) => <span className="image-workbench-reference" title={path} key={path}><ImageIcon size={14} /><b>{imageName(path)}</b><button className="icon-button" title="移除参考图" disabled={generating} onClick={() => setReferencePaths((current) => current.filter((item) => item !== path))}><X size={14} /></button></span>)}
          </div>
        </aside>

        <section className="image-workbench-results">
          <div className="image-workbench-results-head"><strong>独立生成结果</strong>{progress.total > 0 && <span>{progress.done}/{progress.total}</span>}</div>
          {results.map((result) => {
            const active = result.status === "queued" || result.status === "running" || result.status === "paused";
            const jobId = result.jobId;
            const editing = editingPrompt?.key === result.key;
            const promptDraft = editing ? editingPrompt?.value ?? "" : "";
            return (
              <article className={`image-workbench-result ${result.status}`} key={result.key}>
                <header>
                  <div><strong>{result.name}</strong><span className={`job-state ${result.status}`}>{statusText[result.status]}</span></div>
                  <div className="image-workbench-result-actions">
                    {active
                      ? <button className="danger-button compact-button" title="停止" onClick={() => void stopOne(result)}><Square size={15} /> 停止</button>
                      : editing
                        ? <>
                            <button className="primary-button compact-button" disabled={!normalizeEditedImagePrompt(promptDraft)} onClick={() => savePromptEdit(result)}>保存</button>
                            <button className="secondary-button compact-button" onClick={() => setEditingPrompt(null)}>取消</button>
                          </>
                        : <>
                            <button className="secondary-button compact-button" onClick={() => beginPromptEdit(result)}><Pencil size={15} /> 编辑</button>
                            <button className="secondary-button compact-button" title={result.status === "error" ? "重试生成" : "重新生成"} onClick={() => void regenerate(result)}>{result.status === "error" ? <RotateCcw size={15} /> : <Play size={15} />} 重发</button>
                          </>}
                  </div>
                </header>
                {editing
                  ? <textarea autoFocus value={promptDraft} onChange={(event) => setEditingPrompt({ key: result.key, value: event.target.value })} />
                  : <div className="image-workbench-result-prompt" title={result.prompt}>{result.prompt}</div>}
                {active && <div className="image-workbench-progress"><div className="progress-track"><div style={{ width: `${result.progress}%` }} /></div><span>{result.progress}%</span></div>}
                {result.error && <div className="inline-error">{result.error}</div>}
                <div className="image-workbench-thumbnails">
                  {jobId && result.imagePaths.map((path, imageIndex) => (
                    <figure key={`${path}-${imageIndex}`}>
                      <button title="预览图片" onClick={() => setPreview({ jobId, imageIndex, version: result.updatedAt })}><img src={standaloneImageUrl(jobId, imageIndex, result.updatedAt)} alt={`${result.name} ${imageIndex + 1}`} /></button>
                      <figcaption><span>{imageIndex + 1}</span><button className="icon-button" title="用系统程序打开" onClick={() => void window.offline.files.openPath(path)}><Eye size={14} /></button></figcaption>
                    </figure>
                  ))}
                  {!active && result.imagePaths.length === 0 && <div className="image-workbench-placeholder"><ImageIcon size={26} /><span>暂无图片</span></div>}
                </div>
              </article>
            );
          })}
          {results.length === 0 && <div className="empty-state compact"><ImageIcon size={28} /><strong>还没有图片</strong></div>}
        </section>
      </div>

      {preview && (
        <div className="image-workbench-preview" role="dialog" aria-modal="true" onClick={() => setPreview(null)}>
          <button className="icon-button" title="关闭预览" onClick={() => setPreview(null)}><X size={20} /></button>
          <img src={standaloneImageUrl(preview.jobId, preview.imageIndex, preview.version)} alt="图片预览" onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
