import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type ReactElement } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Clock3,
  GripVertical,
  ListChecks,
  Pause,
  Play,
  Plus,
  RotateCcw,
  SkipForward,
  Square,
  Trash2,
} from "lucide-react";
import type { Project, Storyboard, WorkflowJob, WorkflowJobEvent, WorkflowJobStatus } from "../../../shared/contracts";
import { eventDetailText, issueEvents } from "../lib/job-events";
import { batchQueueController } from "./batch-queue-controller";
import {
  batchQueueCounts,
  batchStartConflictMessage,
  canReorderBatchQueueEntry,
  emptyBatchQueueSnapshot,
  isBatchQueueProjectProtected,
  activeBatchStartConflicts,
  removableBatchQueueEntryIds,
  summarizeBatchProject,
  type BatchProjectProgress,
  type BatchQueueSnapshot,
  type BatchQueueStatus,
} from "./batch-queue-state";
import { summarizeBatchJobs } from "./workflow-job-state";

const BATCH_ENTRY_DRAG_TYPE = "application/x-ai-tool-batch-entry";

const jobStatusText: Record<WorkflowJobStatus, string> = {
  queued: "等待中",
  running: "运行中",
  paused: "已暂停",
  done: "已完成",
  error: "失败",
  cancelled: "已停止",
};

const queueStatusText: Record<BatchQueueStatus, string> = {
  waiting: "等待中",
  running: "执行中",
  done: "已完成",
  skipped: "已跳过",
  error: "失败",
};

const typeText: Record<string, string> = {
  "opening.optimize": "开头优化",
  "text.polish": "文本润色",
  "storyboard.infer": "小说转分镜",
  "image.generate": "图片生成",
  "video.generate": "视频生成",
};

function localDateTimeValue(timestamp: number): string {
  const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function countdownText(timestamp: number | null): string {
  if (timestamp === null) return "";
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return "即将开始";
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return `${hours ? `${hours}时` : ""}${minutes}分${seconds}秒后开始`;
}

export function BatchPage(): ReactElement {
  const [mode, setMode] = useState<"projects" | "jobs">("projects");
  const [snapshot, setSnapshot] = useState<BatchQueueSnapshot>(() => batchQueueController.getSnapshot() ?? emptyBatchQueueSnapshot());
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState<number[]>([]);
  const [selectedEntryIds, setSelectedEntryIds] = useState<string[]>([]);
  const [storyboardsByProject, setStoryboardsByProject] = useState<Record<number, Storyboard[]>>({});
  const [jobs, setJobs] = useState<WorkflowJob[]>([]);
  const [filter, setFilter] = useState<"all" | WorkflowJobStatus>("all");
  const [countdown, setCountdown] = useState(() => countdownText(snapshot.scheduledAt));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [eventsByJob, setEventsByJob] = useState<Record<string, WorkflowJobEvent[]>>({});
  const [eventsBusy, setEventsBusy] = useState<string | null>(null);
  const [draggedEntryId, setDraggedEntryId] = useState<string | null>(null);
  const [dragTargetEntryId, setDragTargetEntryId] = useState<string | null>(null);
  const draggedEntryRef = useRef<string | null>(null);

  useEffect(() => batchQueueController.subscribe(setSnapshot), []);

  useEffect(() => {
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const nextProjects = await window.offline.projects.list();
        const nextJobs = await window.offline.jobs.list();
        const projectIds = new Set([...nextProjects.map(({ id }) => id), ...snapshot.entries.map(({ projectId }) => projectId)]);
        const rows = await Promise.all([...projectIds].map(async (projectId) => [
          projectId,
          await window.offline.storyboards.list(projectId).catch(() => []),
        ] as const));
        if (disposed) return;
        setProjects(nextProjects);
        setJobs(nextJobs);
        setStoryboardsByProject(Object.fromEntries(rows));
        setError("");
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [snapshot.entries.map(({ projectId }) => projectId).join(",")]);

  useEffect(() => {
    setCountdown(countdownText(snapshot.scheduledAt));
    if (snapshot.scheduledAt === null) return;
    const timer = window.setInterval(() => setCountdown(countdownText(snapshot.scheduledAt)), 1_000);
    return () => window.clearInterval(timer);
  }, [snapshot.scheduledAt]);

  const projectStats = useMemo<Record<number, BatchProjectProgress>>(() => Object.fromEntries(
    Object.entries(storyboardsByProject).map(([projectId, storyboards]) => [
      Number(projectId),
      summarizeBatchProject(storyboards, jobs),
    ]),
  ), [jobs, storyboardsByProject]);
  const queueCounts = useMemo(() => batchQueueCounts(snapshot.entries), [snapshot.entries]);
  const removableEntryIds = useMemo(() => removableBatchQueueEntryIds(snapshot.entries), [snapshot.entries]);
  const allRemovableSelected = removableEntryIds.length > 0
    && removableEntryIds.every((id) => selectedEntryIds.includes(id));
  const visibleJobs = useMemo(() => filter === "all" ? jobs : jobs.filter((job) => job.status === filter), [filter, jobs]);
  const jobCounts = useMemo(() => summarizeBatchJobs(visibleJobs), [visibleJobs]);
  const startConflicts = useMemo(() => activeBatchStartConflicts(jobs), [jobs]);

  const addProjects = (): void => {
    const additions = projects.filter((project) => selectedProjectIds.includes(project.id)
      && !isBatchQueueProjectProtected(snapshot.entries, project.id));
    batchQueueController.addProjects(additions);
    setSelectedProjectIds([]);
    setNotice(additions.length > 0 ? `已添加 ${additions.length} 个项目` : "所选项目已在队列中");
  };

  useEffect(() => {
    const removable = new Set(removableEntryIds);
    setSelectedEntryIds((current) => {
      const next = current.filter((id) => removable.has(id));
      return next.length === current.length ? current : next;
    });
  }, [removableEntryIds.join(",")]);

  const toggleEntry = (id: string): void => {
    setSelectedEntryIds((current) => current.includes(id)
      ? current.filter((entryId) => entryId !== id)
      : [...current, id]);
  };

  const toggleAllEntries = (): void => {
    setSelectedEntryIds(allRemovableSelected ? [] : removableEntryIds);
  };

  const removeSelectedEntries = (): void => {
    if (selectedEntryIds.length === 0) return;
    if (!window.confirm(`从队列移除选中的 ${selectedEntryIds.length} 个项目？运行中的项目不会被移除。`)) return;
    batchQueueController.remove(selectedEntryIds);
    setSelectedEntryIds([]);
  };

  const tonight = (): void => {
    const value = new Date();
    value.setHours(0, 10, 0, 0);
    if (value.getTime() <= Date.now()) value.setDate(value.getDate() + 1);
    batchQueueController.schedule(value.getTime());
    setNotice("已设置：今晚 00:10");
  };

  const stopQueue = async (): Promise<void> => {
    if (!window.confirm("确认停止批量队列？当前项目会被中止。")) return;
    await batchQueueController.stop();
    setNotice("批量队列已停止");
  };

  const taskAction = async (job: WorkflowJob, action: "pause" | "resume" | "cancel" | "retry"): Promise<void> => {
    try {
      await window.offline.jobs[action](job.id);
      setJobs(await window.offline.jobs.list());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const startQueue = async (): Promise<void> => {
    setError("");
    try {
      await batchQueueController.start();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const toggleEvents = async (job: WorkflowJob): Promise<void> => {
    if (expandedJobId === job.id) {
      setExpandedJobId(null);
      return;
    }
    setExpandedJobId(job.id);
    setEventsBusy(job.id);
    try {
      const events = await window.offline.jobs.events(job.id);
      setEventsByJob((current) => ({ ...current, [job.id]: issueEvents(events) }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setEventsBusy(null);
    }
  };

  const clearDragState = (): void => {
    draggedEntryRef.current = null;
    setDraggedEntryId(null);
    setDragTargetEntryId(null);
  };

  const startEntryDrag = (event: ReactDragEvent<HTMLButtonElement>, id: string): void => {
    if (snapshot.running || snapshot.entries.find((entry) => entry.id === id)?.status !== "waiting") {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(BATCH_ENTRY_DRAG_TYPE, id);
    event.dataTransfer.setData("text/plain", id);
    draggedEntryRef.current = id;
    setDraggedEntryId(id);
    setDragTargetEntryId(null);
  };

  const entryDragId = (event: ReactDragEvent<HTMLElement>): string => (
    draggedEntryRef.current
    || event.dataTransfer.getData(BATCH_ENTRY_DRAG_TYPE)
    || event.dataTransfer.getData("text/plain")
  );

  const dragEntryOver = (event: ReactDragEvent<HTMLElement>, targetId: string): void => {
    const id = entryDragId(event);
    if (snapshot.running || !canReorderBatchQueueEntry(snapshot.entries, id, targetId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragTargetEntryId(targetId);
  };

  const dropEntry = (event: ReactDragEvent<HTMLElement>, targetId: string): void => {
    const id = entryDragId(event);
    if (canReorderBatchQueueEntry(snapshot.entries, id, targetId)) {
      event.preventDefault();
      batchQueueController.reorder(id, targetId);
    }
    clearDragState();
  };

  return (
    <div className="page-shell batch-page">
      <header className="page-header">
        <div>
          <h1>批量执行</h1>
          <p>等待 {queueCounts.waiting} · 执行 {queueCounts.running} · 完成 {queueCounts.done} · 失败 {queueCounts.errors}</p>
        </div>
        <div className="segmented-control batch-view-switch">
          <button className={mode === "projects" ? "selected" : ""} onClick={() => setMode("projects")}><ListChecks size={16} /> 项目队列</button>
          <button className={mode === "jobs" ? "selected" : ""} onClick={() => setMode("jobs")}><Clock3 size={16} /> 底层任务 ({jobCounts.active + jobCounts.paused + jobCounts.errors})</button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      {mode === "projects" ? (
        <>
          <section className="project-batch-add">
            <select
              multiple
              value={selectedProjectIds.map(String)}
              disabled={snapshot.running}
              onChange={(event) => setSelectedProjectIds([...event.currentTarget.selectedOptions].map((option) => Number(option.value)))}
            >
              {projects.map((project) => <option value={project.id} key={project.id} disabled={isBatchQueueProjectProtected(snapshot.entries, project.id)}>{project.name}</option>)}
            </select>
            <button className="secondary-button" disabled={snapshot.running || selectedProjectIds.length === 0} onClick={addProjects}><Plus size={17} /> 加入队列 ({selectedProjectIds.length})</button>
          </section>

          {!snapshot.running && <section className="project-batch-schedule">
            <CalendarClock size={17} /><span>定时</span>
            <button className="secondary-button compact" disabled={snapshot.running} onClick={tonight}>今晚 00:10</button>
            <input
              type="datetime-local"
              value={snapshot.scheduledAt ? localDateTimeValue(snapshot.scheduledAt) : ""}
              min={localDateTimeValue(Date.now() + 60_000)}
              disabled={snapshot.running}
              onChange={(event) => batchQueueController.schedule(event.target.value ? new Date(event.target.value).getTime() : null)}
            />
            {snapshot.scheduledAt !== null && <><strong>{countdown}</strong><button className="icon-button" title="取消定时" onClick={() => batchQueueController.schedule(null)}><Trash2 size={15} /></button></>}
          </section>}

          <section className="project-batch-list">
            <div className="project-batch-list-head">
              <div className="project-batch-head-title">
                <strong>执行队列</strong>
                <label className="project-batch-select-all">
                  <input type="checkbox" checked={allRemovableSelected} disabled={removableEntryIds.length === 0} onChange={toggleAllEntries} />
                  <span>全选</span>
                </label>
              </div>
              <div className="project-batch-head-actions">
                <span>{snapshot.entries.length ? `${queueCounts.done}/${snapshot.entries.length} 完成` : ""}</span>
                <button className="secondary-button compact" disabled={selectedEntryIds.length === 0} onClick={removeSelectedEntries}><Trash2 size={15} /> 批量删除 ({selectedEntryIds.length})</button>
              </div>
            </div>
            {snapshot.entries.map((entry, index) => {
              const stats = projectStats[entry.projectId];
              return (
                <article
                  className={`project-batch-row ${entry.status}${draggedEntryId === entry.id ? " dragging" : ""}${dragTargetEntryId === entry.id ? " drag-target" : ""}`}
                  key={entry.id}
                  onDragEnter={(event) => dragEntryOver(event, entry.id)}
                  onDragOver={(event) => dragEntryOver(event, entry.id)}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragTargetEntryId(null);
                  }}
                  onDrop={(event) => dropEntry(event, entry.id)}
                >
                  <input
                    className="project-batch-checkbox"
                    type="checkbox"
                    aria-label={`选择队列项目 ${entry.projectName}`}
                    checked={selectedEntryIds.includes(entry.id)}
                    disabled={entry.status === "running"}
                    onChange={() => toggleEntry(entry.id)}
                  />
                  <button
                    type="button"
                    className="project-batch-drag-handle"
                    title={entry.status === "waiting" && !snapshot.running ? "拖拽排序" : "当前项目不可拖动"}
                    aria-label={`拖动队列项目 ${entry.projectName}`}
                    disabled={snapshot.running || entry.status !== "waiting"}
                    draggable={!snapshot.running && entry.status === "waiting"}
                    onDragStart={(event) => startEntryDrag(event, entry.id)}
                    onDragEnd={clearDragState}
                  >
                    <GripVertical size={17} />
                  </button>
                  <span className="project-batch-index">{index + 1}</span>
                  <div className="project-batch-copy">
                    <strong>{entry.projectName}</strong>
                    <span>{stats ? `${stats.done}/${stats.total} 个视频${stats.active ? ` · ${stats.active} 进行中` : ""}${stats.paused ? ` · ${stats.paused} 已暂停` : ""}` : "读取中"}</span>
                    <div className="progress-track"><div style={{ width: `${entry.status === "done" ? 100 : stats?.percent ?? 0}%` }} /></div>
                    {entry.error && <small className="inline-error">{entry.error}</small>}
                  </div>
                  <span className={`job-state ${entry.status === "waiting" ? "queued" : entry.status === "skipped" ? "cancelled" : entry.status}`}>{queueStatusText[entry.status]}</span>
                  <div className="project-batch-actions">
                    {entry.status === "error" && <button className="icon-button" title="重新排队" disabled={snapshot.running} onClick={() => batchQueueController.retry(entry.id)}><RotateCcw size={16} /></button>}
                    <button className="icon-button" title="上移" disabled={snapshot.running || entry.status !== "waiting" || index === 0} onClick={() => batchQueueController.move(entry.id, -1)}><ChevronUp size={16} /></button>
                    <button className="icon-button" title="下移" disabled={snapshot.running || entry.status !== "waiting" || index === snapshot.entries.length - 1} onClick={() => batchQueueController.move(entry.id, 1)}><ChevronDown size={16} /></button>
                    {entry.status !== "running" && <button className="icon-button danger" title="移除" onClick={() => batchQueueController.remove([entry.id])}><Trash2 size={16} /></button>}
                  </div>
                </article>
              );
            })}
            {snapshot.entries.length === 0 && <div className="empty-state compact">选择一个或多个项目加入队列</div>}
          </section>

          <div className="project-batch-controls">
            {snapshot.running ? (
              <>
                <button className="danger-button" onClick={() => void stopQueue()}><Square size={16} /> 停止队列</button>
                <button className="secondary-button" disabled={snapshot.currentProjectId === null} onClick={() => void batchQueueController.skipCurrent()}><SkipForward size={16} /> 跳过当前</button>
              </>
            ) : (
              <button className="primary-button" disabled={startConflicts.length > 0 || !snapshot.entries.some((entry) => entry.status === "waiting")} onClick={() => void startQueue()}><Play size={17} /> 开始队列</button>
            )}
            <button className="secondary-button" disabled={(queueCounts.done + queueCounts.skipped + queueCounts.errors) === 0} onClick={() => batchQueueController.clearFinished()}><Trash2 size={16} /> 清空已处理</button>
          </div>
          {startConflicts.length > 0 && !snapshot.running && <div className="warning-banner">{batchStartConflictMessage(startConflicts)}</div>}
        </>
      ) : (
        <>
          <div className="batch-job-filter">
            <select className="filter-select" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
              <option value="all">全部状态</option>
              {Object.entries(jobStatusText).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </div>
          <div className="job-list">
            {visibleJobs.map((job) => (
              <article className="job-row" key={job.id}>
                <div className="job-row-title"><strong>{typeText[job.type] ?? job.type}</strong><span>{new Date(job.createdAt).toLocaleString("zh-CN")}</span></div>
                <div className="job-row-progress"><div className="progress-track"><div style={{ width: `${job.progress}%` }} /></div><span>{job.progress}%</span></div>
                <span className={`job-state ${job.status}`}>{jobStatusText[job.status]}</span>
                <div className="job-row-actions">
                  {job.status === "running" && <button className="icon-button" title="暂停" onClick={() => void taskAction(job, "pause")}><Pause size={16} /></button>}
                  {job.status === "paused" && <button className="icon-button" title="继续" onClick={() => void taskAction(job, "resume")}><Play size={16} /></button>}
                  {job.status === "error" && <button className="icon-button" title="重试" onClick={() => void taskAction(job, "retry")}><RotateCcw size={16} /></button>}
                  {!['done', 'cancelled'].includes(job.status) && <button className="icon-button danger" title="停止" onClick={() => void taskAction(job, "cancel")}><Square size={15} /></button>}
                  <button className="icon-button" title={expandedJobId === job.id ? "收起错误详情" : "查看错误详情"} disabled={eventsBusy === job.id} onClick={() => void toggleEvents(job)}>{expandedJobId === job.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
                </div>
                {job.status === "error" && job.error && <div className="job-error-summary">{job.error}</div>}
                {expandedJobId === job.id && (
                  <div className="job-event-details">
                    {eventsBusy === job.id && <span>正在读取错误记录...</span>}
                    {eventsBusy !== job.id && (eventsByJob[job.id]?.length ?? 0) === 0 && <span>没有错误或警告事件</span>}
                    {eventsByJob[job.id]?.map((event) => {
                      const detail = eventDetailText(event.detail);
                      return <div className={`job-event-entry ${event.level}`} key={event.id}><div><strong>{event.level === "error" ? "错误" : "警告"}</strong><time>{new Date(event.createdAt).toLocaleString("zh-CN")}</time></div><span>{event.message}</span>{detail && <pre>{detail}</pre>}</div>;
                    })}
                  </div>
                )}
              </article>
            ))}
            {visibleJobs.length === 0 && <div className="empty-state compact">没有符合条件的任务</div>}
          </div>
        </>
      )}
    </div>
  );
}
