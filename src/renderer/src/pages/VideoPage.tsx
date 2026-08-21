import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Link2, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import type { LocalMediaSelector } from "../../../shared/local-media";
import type { Project, Storyboard, ViduAccount, ViduModel, VideoProvider, WorkflowJob } from "../../../shared/contracts";
import { ModalDialog } from "../components/ModalDialog";
import { StoryboardMediaPreview } from "../components/StoryboardMediaPreview";
import {
  confirmVideoRegeneration,
  hasUsableViduAccount,
  storyboardWorkflowJob,
  summarizeStoryboardWorkflow,
} from "./workflow-job-state";
import { storyboardDisplayState } from "./storyboard-display-state";

const ACTIVE_STATUSES = new Set(["queued", "running", "paused"]);

export function VideoPage(): ReactElement {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [storyboards, setStoryboards] = useState<Storyboard[]>([]);
  const [jobs, setJobs] = useState<WorkflowJob[]>([]);
  const [viduAccounts, setViduAccounts] = useState<ViduAccount[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [provider, setProvider] = useState<VideoProvider>("custom-api");
  const [viduModel, setViduModel] = useState<ViduModel>("Q3");
  const [useCredits, setUseCredits] = useState(true);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [uncertainStoryboard, setUncertainStoryboard] = useState<Storyboard | null>(null);
  const [uncertainTaskId, setUncertainTaskId] = useState("");
  const [uncertainClearConfirmed, setUncertainClearConfirmed] = useState(false);

  const refresh = useCallback(async (selectedId = projectId): Promise<void> => {
    const [nextJobs, nextStoryboards, nextViduAccounts] = await Promise.all([
      window.offline.jobs.list(),
      selectedId ? window.offline.storyboards.list(selectedId) : Promise.resolve([]),
      window.offline.vidu.listAccounts(),
    ]);
    setJobs(nextJobs);
    setStoryboards(nextStoryboards);
    setViduAccounts(nextViduAccounts);
  }, [projectId]);

  useEffect(() => {
    void Promise.all([
      window.offline.projects.list(),
      window.offline.settings.get("video_provider"),
      window.offline.settings.get("vidu_model"),
      window.offline.settings.get("vidu_use_credits"),
      window.offline.settings.get("video_aspect_ratio"),
    ]).then(([items, configuredProvider, configuredModel, configuredCredits, configuredAspectRatio]) => {
      setProvider(configuredProvider === "vidu-browser" ? "vidu-browser" : "custom-api");
      setViduModel(configuredModel?.toUpperCase() === "Q2" ? "Q2" : "Q3");
      setUseCredits(configuredCredits !== "false");
      setAspectRatio(configuredAspectRatio || "16:9");
      setProjects(items);
      const first = items[0]?.id ?? null;
      setProjectId(first);
      return refresh(first);
    }).catch((reason) => setError(String(reason)));
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    const poll = async (): Promise<void> => {
      await refresh().catch((reason) => setError(String(reason)));
      if (!disposed) timer = window.setTimeout(() => void poll(), 5_000);
    };
    timer = window.setTimeout(() => void poll(), 5_000);
    const onFocus = (): void => { void refresh().catch((reason) => setError(String(reason))); };
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const summary = useMemo(
    () => summarizeStoryboardWorkflow(storyboards, jobs, "video.generate"),
    [jobs, storyboards],
  );
  const runnable = summary.runnable;
  const videoProviderReady = provider !== "vidu-browser" || hasUsableViduAccount(viduAccounts);

  const confirmRegeneration = (storyboard: Storyboard): boolean => confirmVideoRegeneration(
    storyboard,
    (message) => window.confirm(message),
  );

  const enqueue = async (storyboard: Storyboard, refreshAfterEnqueue = true): Promise<void> => {
    if (!videoProviderReady && !storyboard.videoTaskId) throw new Error("没有可用的 Vidu 账号，请先在设置中添加、启用并登录账号");
    if (!confirmRegeneration(storyboard)) return;
    await window.offline.jobs.enqueue("video.generate", {
      storyboardId: storyboard.id,
      provider,
      viduModel,
      useCredits,
      aspectRatio,
      durationSeconds: storyboard.duration,
    });
    if (refreshAfterEnqueue) await refresh();
  };

  const generateAll = async (): Promise<void> => {
    if (!videoProviderReady) {
      setError("没有可用的 Vidu 账号，请先在设置中添加、启用并登录账号");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    let added = 0;
    const failures: string[] = [];
    try {
      for (const storyboard of runnable) {
        try {
          await enqueue(storyboard, false);
          added += 1;
        } catch (reason) {
          failures.push(`#${storyboard.index + 1} ${reason instanceof Error ? reason.message : String(reason)}`);
        }
      }
      if (failures.length > 0) setError(`${failures.length} 个任务未加入：${failures.slice(0, 3).join("；")}`);
      setNotice(`已加入 ${added} 个视频任务`);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const taskAction = async (job: WorkflowJob, action: "cancel" | "resume" | "retry"): Promise<void> => {
    setError("");
    try {
      await window.offline.jobs[action](job.id);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const retry = async (storyboard: Storyboard, job: WorkflowJob): Promise<void> => {
    if (!confirmRegeneration(storyboard)) return;
    await taskAction(job, "retry");
  };

  const openUncertainResolution = (storyboard: Storyboard): void => {
    setUncertainStoryboard(storyboard);
    setUncertainTaskId("");
    setUncertainClearConfirmed(false);
  };

  const closeUncertainResolution = (): void => {
    setUncertainStoryboard(null);
    setUncertainTaskId("");
    setUncertainClearConfirmed(false);
  };

  const bindUncertainTask = async (): Promise<void> => {
    if (!uncertainStoryboard || !uncertainTaskId.trim()) return;
    const storyboard = uncertainStoryboard;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await window.offline.vidu.resolveUncertain(storyboard.id, { taskId: uncertainTaskId.trim() });
      closeUncertainResolution();
      setNotice(`分镜 ${storyboard.index + 1} 已绑定网站任务，可以继续检查`);
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
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await window.offline.vidu.resolveUncertain(storyboard.id, { clear: true });
      closeUncertainResolution();
      setNotice(`分镜 ${storyboard.index + 1} 已解除待确认状态，现在可以重新提交`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const mediaAction = async (selector: LocalMediaSelector, action: "open" | "reveal"): Promise<void> => {
    try {
      await window.offline.media[action](selector);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="page-shell video-page">
      <header className="page-header">
        <div>
          <h1>视频生成</h1>
          <p>分镜 {storyboards.length} · 进行中 {summary.active} · 已暂停 {summary.paused} · {provider === "vidu-browser" ? "Vidu 浏览器" : "自定义 API"}</p>
        </div>
        <div className="workflow-actions">
          <button className="icon-button" title="刷新任务状态" onClick={() => void refresh()}><RefreshCw size={17} /></button>
          <button className="primary-button" disabled={busy || runnable.length === 0 || !videoProviderReady} onClick={() => void generateAll()}><Play size={17} /> 生成缺失视频 ({runnable.length})</button>
        </div>
      </header>

      <div className="video-workflow-toolbar">
        <label><span>项目</span><select value={projectId ?? ""} onChange={(event) => { const id = Number(event.target.value) || null; setProjectId(id); void refresh(id); }}><option value="">选择项目</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
        <label><span>模型</span><select value={viduModel} disabled={provider !== "vidu-browser"} onChange={(event) => setViduModel(event.target.value as ViduModel)}><option value="Q3">Vidu Q3</option><option value="Q2">Vidu Q2</option></select></label>
        <label><span>宽高比</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option value="16:9">16:9 横屏</option><option value="9:16">9:16 竖屏</option><option value="1:1">1:1 方形</option><option value="4:3">4:3</option><option value="3:4">3:4</option></select></label>
        <label className="toggle-row video-credit-toggle"><span>使用积分</span><input type="checkbox" checked={useCredits} disabled={provider !== "vidu-browser"} onChange={(event) => setUseCredits(event.target.checked)} /></label>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!videoProviderReady && <div className="warning-banner">当前没有可用的 Vidu 账号，请先在设置中添加、启用并登录账号。</div>}
      {notice && <div className="success-banner file-notice">{notice}</div>}

      <div className="video-storyboard-list">
        {storyboards.map((storyboard) => {
          const job = storyboardWorkflowJob(storyboard.id, "video.generate", jobs);
          const running = Boolean(job && (job.status === "queued" || job.status === "running"));
          const state = storyboardDisplayState(storyboard, jobs);
          const selector: LocalMediaSelector | null = state.mediaKind === "video"
            ? { storyboardId: storyboard.id, kind: "video" }
            : state.mediaKind === "image" && state.imageIndex !== null
              ? { storyboardId: storyboard.id, kind: "image", index: state.imageIndex }
              : null;
          return (
            <article className={`video-storyboard-row ${state.status}`} key={storyboard.id}>
              <div className="image-sequence">{storyboard.index + 1}</div>
              <div className="image-copy">
                <strong>{storyboard.originalText || "未填写原文"}</strong>
                <p>{storyboard.prompt || "请先在项目分镜中填写画面提示词"}</p>
                {storyboard.videoSubmissionState === "uncertain" && <div className="inline-error">Vidu 提交结果待确认，已禁止自动重发</div>}
                {job?.error && <div className="inline-error">{job.error}</div>}
              </div>
              <StoryboardMediaPreview
                storyboard={storyboard}
                state={state}
                onOpen={() => { if (selector) void mediaAction(selector, "open"); }}
                onReveal={() => { if (selector) void mediaAction(selector, "reveal"); }}
              />
              <div className="image-task-state">
                <span className={`status-label ${state.status}`}>{state.label}</span>
                {state.progress !== null && <><div className="progress-track"><div style={{ width: `${state.progress}%` }} /></div><small>{state.progress}%</small></>}
              </div>
              <div className="image-row-actions">
                {storyboard.videoSubmissionState === "uncertain" ? <button className="secondary-button" title="绑定 Vidu task ID 或确认清除" onClick={() => openUncertainResolution(storyboard)}><Link2 size={15} /> 确认任务</button>
                  : running ? <button className="icon-button danger" title="停止" onClick={() => void taskAction(job!, "cancel")}><Square size={15} /></button>
                    : job?.status === "paused" ? <><button className="icon-button" title="继续" onClick={() => void taskAction(job, "resume")}><Play size={16} /></button><button className="icon-button danger" title="停止" onClick={() => void taskAction(job, "cancel")}><Square size={15} /></button></>
                      : job?.status === "error" ? <button className="icon-button" title="重试" disabled={!videoProviderReady && !storyboard.videoTaskId} onClick={() => void retry(storyboard, job)}><RotateCcw size={16} /></button>
                        : storyboard.videoTaskId ? <button className="secondary-button compact-button" title="继续追踪已有网站任务" onClick={() => void enqueue(storyboard)}><RefreshCw size={15} /> 检查</button>
                          : storyboard.videoPath ? <button className="icon-button" title="重新生成视频" disabled={!storyboard.prompt.trim() || !videoProviderReady} onClick={() => void enqueue(storyboard)}><RotateCcw size={16} /></button>
                            : <button className="icon-button" title="生成视频" disabled={!storyboard.prompt.trim() || !videoProviderReady} onClick={() => void enqueue(storyboard)}><Play size={16} /></button>}
              </div>
            </article>
          );
        })}
        {projectId && storyboards.length === 0 && <div className="empty-state compact">该项目还没有分镜</div>}
        {!projectId && <div className="empty-state compact">请选择一个项目</div>}
      </div>

      <ModalDialog
        open={uncertainStoryboard !== null}
        title={uncertainStoryboard ? `确认 Vidu 任务 · 分镜 #${uncertainStoryboard.index + 1}` : "确认 Vidu 任务"}
        description="提交阶段曾中断，程序不会自动重发，以免重复扣除积分。"
        busy={busy}
        onClose={closeUncertainResolution}
        actions={(
          <>
            <button className="secondary-button" disabled={busy} onClick={closeUncertainResolution}>取消</button>
            <button className="danger-button" disabled={busy || !uncertainClearConfirmed} onClick={() => void clearUncertainSubmission()}>
              确认无此任务并清除
            </button>
            <button className="primary-button" disabled={busy || !uncertainTaskId.trim()} onClick={() => void bindUncertainTask()}>
              <Link2 size={15} /> 绑定任务
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
              <small>找到对应任务时输入 ID，程序会继续追踪原任务，不会重复提交。</small>
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
    </div>
  );
}
