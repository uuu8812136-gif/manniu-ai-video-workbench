import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src", "renderer", "src", "pages", "ProjectsPage.tsx"), "utf8");
const detailSource = readFileSync(join(process.cwd(), "src", "renderer", "src", "pages", "ProjectDetailPage.tsx"), "utf8");
const stylesSource = readFileSync(join(process.cwd(), "src", "renderer", "src", "styles.css"), "utf8");

describe("project batch generation contract", () => {
  it("uses the ordered video generation target helper", () => {
    const generateManySource = detailSource.slice(
      detailSource.indexOf("const generateMany"),
      detailSource.indexOf("const checkAll"),
    );
    expect(generateManySource).toContain("videoGenerationTargets(items, regenerateExisting)");
    expect(generateManySource).toContain("regenerateExisting, false)");
    expect(generateManySource.match(/await refresh\(true\)/gu)).toHaveLength(1);
  });

  it("replaces stale enqueue success feedback when asynchronous video work fails", () => {
    expect(detailSource).toContain('job.type === "video.generate" && job.status === "error"');
    expect(detailSource).toContain('current.startsWith("已加入") ? "" : current');
    expect(detailSource).toContain('className="failure-summary"');
  });

  it("queries only project jobs and preserves unchanged event state", () => {
    expect(detailSource).toContain("window.offline.jobs.latestForStoryboards(nextStoryboards.map(({ id }) => id))");
    expect(detailSource).toContain("window.offline.jobs.events(job.id, 50)");
    expect(detailSource).toContain("reconcileJobEvents(current, nextJobEvents)");
  });
});

describe("project page parity contract", () => {
  it("creates projects in a modal and exposes delete locks before clicking", () => {
    expect(source).toContain("<ModalDialog");
    expect(source).toContain('title="新建项目"');
    expect(source).not.toContain('<section className="project-create-panel">');
    expect(source).toContain("projectDeleteLockReason(");
    expect(source).toContain('disabled={Boolean(deleteLockReason)}');
    expect(source).toContain('title={deleteLockReason ? `${deleteLockReason}，暂不能删除` : "删除项目"}');
  });

  it("opens project directories without changing their binding", () => {
    expect(source).toContain("window.offline.files.openPath(project.folderPath)");
    expect(source).toContain('title={project.folderPath ? "打开项目目录" : "项目目录未设置"}');
    expect(detailSource).toContain('runFileAction("project-folder-open"');
    expect(detailSource).toContain("window.offline.files.openPath(project.folderPath)");
    expect(detailSource).toContain("更改项目绑定目录");
    expect(detailSource).toContain("打开资产图文件夹");
  });

  it("uses the original project-detail workbench structure", () => {
    expect(detailSource).toContain('className="storyboard-card-list"');
    expect(detailSource).toContain('className={`storyboard-card-row ${state.status}`}');
    expect(detailSource).not.toContain('<table className="storyboard-table storyboard-media-table">');
    expect(detailSource).toContain('title={editingStoryboard ? `编辑分镜 #${editingStoryboard.index + 1}` : "编辑分镜"}');
    expect(detailSource).toContain('className="sent-progress-track"');
    expect(detailSource).toContain('title="本地任务额度估算；网站实时积分请在设置中检查账号">本地账号任务额度');
    expect(stylesSource).toMatch(/\.project-detail-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 316px;/su);
    expect(stylesSource).toMatch(/\.storyboard-card-row\s*\{[^}]*content-visibility:\s*auto;/su);
    expect(stylesSource).toMatch(/\.automation-sidebar\s*\{[^}]*overflow-y:\s*auto;/su);
  });

  it("resolves uncertain submissions and confirms storyboard deletion inside the app", () => {
    expect(detailSource).not.toContain("window.prompt(");
    expect(detailSource).toContain('className="uncertain-resolution-form"');
    expect(detailSource).toContain("确认无此任务并清除");
    expect(detailSource).toContain("disabled={busy || !uncertainClearConfirmed}");
    expect(detailSource).toContain("await window.offline.vidu.resolveUncertain(storyboard.id, { taskId: uncertainTaskId.trim() })");
    expect(detailSource).toContain("await window.offline.vidu.resolveUncertain(storyboard.id, { clear: true })");
    expect(detailSource).toContain("await assertNoActiveMediaJobs([deletingStoryboard.id]");
    expect(detailSource).toContain("await window.offline.storyboards.delete(deletingStoryboard.id)");
    expect(detailSource).toContain("forceDeleteTrackedVideo");
    expect(detailSource).toContain("await window.offline.storyboards.forceStopVideo(deletingStoryboard.id)");
    expect(detailSource).toContain("停止跟踪并删除");
    expect(detailSource).toContain("不会自动检查或下载该网站任务的结果");
    expect(stylesSource).toContain(".uncertain-clear-confirmation");
  });

  it("confirms project reset inside the app and permits clearing abnormal state", () => {
    expect(detailSource).toContain("showResetConfirmation");
    expect(detailSource).toContain('title="清空重来"');
    expect(detailSource).toContain("setShowResetConfirmation(true)");
    expect(detailSource).not.toContain('confirm("清空全部生成状态');
  });
});
