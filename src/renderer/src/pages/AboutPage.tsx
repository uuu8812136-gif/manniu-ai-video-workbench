import { useEffect, useState, type ReactElement } from "react";
import { BookOpenText, CheckCircle2, Database, FolderCheck, GraduationCap, MessageSquareWarning, RefreshCw } from "lucide-react";
import type { DiagnosticReport } from "../../../shared/contracts";
import packageJson from "../../../../package.json";

type HelpPanel = "documentation" | "tutorial" | null;
const appVersion = packageJson.version;

export function AboutPage(): ReactElement {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [helpPanel, setHelpPanel] = useState<HelpPanel>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      setReport(await window.offline.diagnostics.run());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void run();
  }, []);

  const prepareFeedback = async (): Promise<void> => {
    if (!report) return;
    setError("");
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      const logs = report.directories.find((item) => item.name === "logs")?.path;
      if (logs) await window.offline.files.openPath(logs);
      setMessage("诊断信息已复制，并已打开日志目录");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const checkUpdate = (): void => {
    setMessage(`当前为 AI工具 v${appVersion} 源码部署版；更新不依赖原作者服务器，可用新版安装包直接覆盖，现有本地数据会保留。`);
  };

  return (
    <div className="page-shell about-page">
      <header className="page-header">
        <div>
          <h1>AI工具</h1>
          <p>版本 {appVersion}</p>
        </div>
        <button className="secondary-button" disabled={busy} onClick={() => void run()}>
          <RefreshCw size={17} /> 重新检测
        </button>
      </header>
      <div className="about-actions">
        <button className="secondary-button" onClick={() => setHelpPanel(helpPanel === "documentation" ? null : "documentation")}><BookOpenText size={17} /> 使用文档</button>
        <button className="secondary-button" onClick={() => setHelpPanel(helpPanel === "tutorial" ? null : "tutorial")}><GraduationCap size={17} /> 新手教程</button>
        <button className="secondary-button" disabled={!report} onClick={() => void prepareFeedback()}><MessageSquareWarning size={17} /> 反馈问题</button>
        <button className="secondary-button" onClick={checkUpdate}><RefreshCw size={17} /> 检查更新</button>
      </div>
      {helpPanel === "documentation" && (
        <section className="about-help-panel">
          <h2>使用文档</h2>
          <div className="about-help-grid">
            <div><strong>创作与批量</strong><span>新建项目后导入或生成分镜，完成图片和视频后可按 SRT 对齐并导出剪映草稿；批量页支持跨项目排队、定时、全选和批量删除。</span></div>
            <div><strong>文本与生图</strong><span>开头、捋文和推理支持 TXT/DOCX 选择与拖入；推理会生成角色表和 CSV；批量生图可独立保存，不会覆盖项目分镜。</span></div>
            <div><strong>模型与 Vidu</strong><span>文本、图片、视频 API 均在设置页使用自己的接口；Vidu 使用 AI工具打开的独立浏览器会话登录自己的账号。</span></div>
            <div><strong>数据与备份</strong><span>项目、任务和设置保存在本机。设置页可创建、校验并恢复完整备份；便携版数据位于程序同级目录。</span></div>
          </div>
        </section>
      )}
      {helpPanel === "tutorial" && (
        <section className="about-help-panel">
          <h2>首次使用流程</h2>
          <ol>
            <li><span>1</span><div><strong>配置模型</strong><small>在设置页填写自己的 API 地址、Key 和模型，然后逐项执行连接测试。</small></div></li>
            <li><span>2</span><div><strong>准备账号</strong><small>需要 Vidu 时添加账号并打开登录窗口；不使用 Vidu 可选择自定义视频 API。</small></div></li>
            <li><span>3</span><div><strong>创建项目</strong><small>输入名称即可在设置的项目根目录自动创建；也可自选目录，并成对绑定 SRT 字幕和旁白音频。</small></div></li>
            <li><span>4</span><div><strong>生成与导出</strong><small>检查提示词，批量生成图片和视频；完成后检查媒体并导出剪映草稿。</small></div></li>
          </ol>
        </section>
      )}
      {message && <div className="success-banner about-message"><CheckCircle2 size={16} /> {message}</div>}
      {error && <div className="error-banner">{error}</div>}
      {report && (
        <>
          <div className={`diagnostic-summary ${report.status}`}>
            <strong>{report.status === "ok" ? "运行环境正常" : "运行环境存在问题"}</strong>
            <span>{new Date(report.generatedAt).toLocaleString("zh-CN")}</span>
          </div>
          <section className="diagnostic-section">
            <div className="diagnostic-heading">
              <Database size={20} />
              <h2>数据库</h2>
            </div>
            <span className={report.sqlite.healthy ? "health-ok" : "health-error"}>
              {report.sqlite.healthy ? "SQLite quick_check 正常" : report.sqlite.error || report.sqlite.result.join(", ")}
            </span>
          </section>
          <section className="diagnostic-section">
            <div className="diagnostic-heading">
              <FolderCheck size={20} />
              <h2>本地目录</h2>
            </div>
            <div className="directory-list">
              {report.directories.map((item) => (
                <div key={item.name}>
                  <span>{item.name}</span>
                  <code>{item.path}</code>
                  <b className={item.writable ? "health-ok" : "health-error"}>{item.writable ? "可写" : "失败"}</b>
                </div>
              ))}
            </div>
          </section>
          <section className="runtime-grid">
            <span>Electron</span><code>{report.runtime.electron ?? "-"}</code>
            <span>Node</span><code>{report.runtime.node}</code>
            <span>Chromium</span><code>{report.runtime.chrome ?? "-"}</code>
            <span>系统</span><code>{report.runtime.platform} / {report.runtime.architecture}</code>
          </section>
        </>
      )}
    </div>
  );
}
