import { useEffect, useState, type ReactElement } from "react";
import { Captions, FilePenLine, FolderOpen, Music, Plus, Trash2 } from "lucide-react";
import type { Project, ProjectCreationMode, Storyboard, WorkflowJob } from "../../../shared/contracts";
import { ModalDialog } from "../components/ModalDialog";
import { batchQueueController } from "./batch-queue-controller";
import { createProjectInput, emptyProjectCreationDraft, projectCreationValidationError } from "./project-creation-state";
import { projectDeleteLockReason } from "./project-list-state";

type ProjectMetric = {
  total: number;
  done: number;
  errors: number;
};

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function projectMetric(storyboards: Storyboard[]): ProjectMetric {
  return {
    total: storyboards.length,
    done: storyboards.filter((item) => Boolean(item.videoPath)).length,
    errors: storyboards.filter((item) => item.status === "error" || item.videoSubmissionState === "uncertain").length,
  };
}

export function ProjectsPage({ onOpen }: { onOpen(project: Project): void }): ReactElement {
  const [projects, setProjects] = useState<Project[]>([]);
  const [metrics, setMetrics] = useState<Record<number, ProjectMetric>>({});
  const [storyboardsByProject, setStoryboardsByProject] = useState<Record<number, Storyboard[]>>({});
  const [jobs, setJobs] = useState<WorkflowJob[]>([]);
  const [, setBatchRevision] = useState(0);
  const [showCreator, setShowCreator] = useState(false);
  const [creationMode, setCreationMode] = useState<ProjectCreationMode>("original");
  const [name, setName] = useState("");
  const [projectBaseFolder, setProjectBaseFolder] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [subtitlePath, setSubtitlePath] = useState("");
  const [audioPath, setAudioPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = async (): Promise<void> => {
    const [items, currentJobs] = await Promise.all([window.offline.projects.list(), window.offline.jobs.list()]);
    const storyboardLists = await Promise.all(items.map((project) => window.offline.storyboards.list(project.id)));
    setProjects(items);
    setJobs(currentJobs);
    setStoryboardsByProject(Object.fromEntries(items.map((project, index) => [project.id, storyboardLists[index] ?? []])));
    setMetrics(Object.fromEntries(items.map((project, index) => [project.id, projectMetric(storyboardLists[index] ?? [])])));
  };

  useEffect(() => {
    const update = (): void => { void refresh().catch((reason) => setError(String(reason))); };
    update();
    const timer = window.setInterval(update, 2_000);
    const unsubscribe = batchQueueController.subscribe(() => setBatchRevision((value) => value + 1));
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!showCreator) return;
    let disposed = false;
    void window.offline.settings.get("project_base_folder")
      .then((value) => { if (!disposed) setProjectBaseFolder(value?.trim() ?? ""); })
      .catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { disposed = true; };
  }, [showCreator]);

  const pick = async (kind: "folder" | "subtitle" | "audio"): Promise<void> => {
    setPickerBusy(true);
    setError("");
    try {
      const path = kind === "folder"
        ? await window.offline.files.pickDirectory("选择新项目目录")
        : await window.offline.files.pickFile(kind);
      if (!path) return;
      if (kind === "folder") setFolderPath(path);
      if (kind === "subtitle") setSubtitlePath(path);
      if (kind === "audio") setAudioPath(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPickerBusy(false);
    }
  };

  const create = async (): Promise<void> => {
    if (busy) return;
    const draft = { mode: creationMode, name, projectBaseFolder, folderPath, subtitlePath, audioPath };
    const validationError = projectCreationValidationError(draft);
    if (validationError) return setError(validationError);
    setBusy(true);
    setError("");
    try {
      const created = await window.offline.projects.create(createProjectInput(draft));
      setName("");
      setFolderPath("");
      setSubtitlePath("");
      setAudioPath("");
      setCreationMode("original");
      setShowCreator(false);
      await refresh();
      onOpen(created);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const creationDraft = { mode: creationMode, name, projectBaseFolder, folderPath, subtitlePath, audioPath };
  const canCreate = projectCreationValidationError(creationDraft) === null;

  const resetCreator = (): void => {
    const empty = emptyProjectCreationDraft(projectBaseFolder);
    setCreationMode(empty.mode);
    setName(empty.name);
    setFolderPath(empty.folderPath);
    setSubtitlePath(empty.subtitlePath);
    setAudioPath(empty.audioPath);
    setError("");
  };

  const openCreator = (): void => {
    setError("");
    setShowCreator(true);
  };

  const closeCreator = (): void => {
    if (busy || pickerBusy) return;
    resetCreator();
    setShowCreator(false);
  };

  const remove = async (project: Project): Promise<void> => {
    const lockReason = projectDeleteLockReason(
      project.id,
      storyboardsByProject[project.id] ?? [],
      jobs,
      batchQueueController.isProjectProtected(project.id),
    );
    if (lockReason) {
      setError(`${lockReason}，暂不能删除`);
      return;
    }
    if (!confirm(`删除项目“${project.name}”？运行中的项目会被保护，且此操作不会删除项目目录里的原始素材。`)) return;
    try {
      await window.offline.projects.delete(project.id);
      batchQueueController.remove(batchQueueController.getSnapshot().entries
        .filter((entry) => entry.projectId === project.id)
        .map((entry) => entry.id));
      await refresh();
      setNotice("已删除");
    } catch (reason) {
      setError(String(reason));
    }
  };

  const openProjectDirectory = async (project: Project): Promise<void> => {
    if (!project.folderPath.trim()) {
      setError(`项目“${project.name}”尚未设置项目目录`);
      return;
    }
    try {
      await window.offline.files.openPath(project.folderPath);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="page-shell projects-page">
      <header className="page-header">
        <div>
          <h1>创作</h1>
          <p>{projects.length} 个本地项目</p>
        </div>
        <button className="primary-button" onClick={openCreator}><Plus size={17} /> 新建项目</button>
      </header>

      <ModalDialog
        open={showCreator}
        title="新建项目"
        description="创建项目并绑定本地素材"
        busy={busy || pickerBusy}
        onClose={closeCreator}
        actions={<><button className="secondary-button" disabled={busy || pickerBusy} onClick={closeCreator}>取消</button><button className="primary-button" disabled={busy || pickerBusy || !canCreate} onClick={() => void create()}><Plus size={17} /> 创建并进入</button></>}
      >
        <div className="project-create-form">
          <div className="segmented-control project-create-mode" role="group" aria-label="项目新建模式">
            <button className={creationMode === "original" ? "selected" : ""} onClick={() => { setCreationMode("original"); setError(""); }}>原版模式</button>
            <button className={creationMode === "advanced" ? "selected" : ""} onClick={() => { setCreationMode("advanced"); setError(""); }}>高级模式</button>
          </div>
          <label className="project-name-input"><span>项目名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void create()} placeholder="输入项目名称" maxLength={160} /></label>
          {creationMode === "original" ? (
            <button className={projectBaseFolder ? "project-material-button selected" : "project-material-button"} disabled title={projectBaseFolder || "请先在设置中配置项目根目录"}><FolderOpen size={18} /><span><strong>项目根目录</strong><small>{projectBaseFolder ? fileName(projectBaseFolder) : "设置中未配置"}</small></span></button>
          ) : (
            <button className={folderPath ? "project-material-button selected" : "project-material-button"} disabled={pickerBusy} title={folderPath || "未选择时使用默认项目目录"} onClick={() => void pick("folder")}><FolderOpen size={18} /><span><strong>项目目录</strong><small>{folderPath ? fileName(folderPath) : "自动创建"}</small></span></button>
          )}
          <button className={subtitlePath ? "project-material-button selected" : "project-material-button"} disabled={pickerBusy} title={subtitlePath || "选择字幕文件"} onClick={() => void pick("subtitle")}><Captions size={18} /><span><strong>字幕文件{creationMode === "original" ? " *" : ""}</strong><small>{subtitlePath ? fileName(subtitlePath) : "未选择"}</small></span></button>
          <button className={audioPath ? "project-material-button selected" : "project-material-button"} disabled={pickerBusy} title={audioPath || "选择旁白音频"} onClick={() => void pick("audio")}><Music size={18} /><span><strong>旁白音频{creationMode === "original" ? " *" : ""}</strong><small>{audioPath ? fileName(audioPath) : "未选择"}</small></span></button>
          {error && <div className="error-banner">{error}</div>}
        </div>
      </ModalDialog>

      {!showCreator && error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}
      {projects.length === 0 ? (
        <div className="empty-state"><FilePenLine size={30} /><strong>还没有创作项目</strong><button className="primary-button" onClick={openCreator}><Plus size={17} /> 新建项目</button></div>
      ) : (
        <div className="project-grid">
          {projects.map((project) => {
            const metric = metrics[project.id] ?? { total: 0, done: 0, errors: 0 };
            const progress = metric.total > 0 ? Math.round((metric.done / metric.total) * 100) : 0;
            const deleteLockReason = projectDeleteLockReason(
              project.id,
              storyboardsByProject[project.id] ?? [],
              jobs,
              batchQueueController.isProjectProtected(project.id),
            );
            return (
              <article className="project-card project-progress-card" key={project.id}>
                <button className="project-open" onClick={() => onOpen(project)}>
                  <span className="project-index">{String(project.id).padStart(2, "0")}</span>
                  <span className="project-copy">
                    <strong>{project.name}</strong>
                    <small>{new Date(project.createdAt).toLocaleDateString("zh-CN")}</small>
                    <span className="project-card-progress"><span><i style={{ width: `${progress}%` }} /></span><b>{metric.done}/{metric.total}</b></span>
                    <em>{metric.errors > 0 ? `${metric.errors} 个异常` : project.folderPath ? fileName(project.folderPath) : "未设置项目目录"}</em>
                  </span>
                </button>
                <div className="project-card-actions">
                  <button className="icon-button" disabled={!project.folderPath.trim()} title={project.folderPath ? "打开项目目录" : "项目目录未设置"} onClick={() => void openProjectDirectory(project)}><FolderOpen size={17} /></button>
                  <button className="icon-button danger" disabled={Boolean(deleteLockReason)} title={deleteLockReason ? `${deleteLockReason}，暂不能删除` : "删除项目"} onClick={() => void remove(project)}><Trash2 size={17} /></button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
