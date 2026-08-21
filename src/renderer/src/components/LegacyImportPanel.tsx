import { useState, type ReactElement } from "react";
import { Database, FolderOpen, Import, ShieldCheck, X } from "lucide-react";
import type { LegacyImportCounts, LegacyImportReport } from "../../../shared/contracts";

function CountGrid({ title, counts }: { title: string; counts: LegacyImportCounts }): ReactElement {
  return (
    <div className="legacy-count-group">
      <strong>{title}</strong>
      <dl>
        <div><dt>项目</dt><dd>{counts.projects}</dd></div>
        <div><dt>分镜</dt><dd>{counts.storyboards}</dd></div>
        <div><dt>配置</dt><dd>{counts.settings}</dd></div>
      </dl>
    </div>
  );
}

function ImportReport({ report }: { report: LegacyImportReport }): ReactElement {
  const displayedMappings = Object.entries(report.projectIdMap).slice(0, 50);
  const isCompleted = !report.dryRun && !report.alreadyImported;
  return (
    <div className="legacy-report" aria-live="polite">
      <div className={`legacy-report-status ${isCompleted ? "complete" : ""}`}>
        <Database size={17} />
        <strong>{report.alreadyImported ? "该数据库已导入" : isCompleted ? "导入完成" : "预览完成"}</strong>
      </div>
      <div className="legacy-counts">
        <CountGrid title="扫描到" counts={report.scanned} />
        <CountGrid title={isCompleted ? "已导入" : "将导入"} counts={isCompleted ? report.imported : report.wouldImport} />
      </div>

      <div className="legacy-skip-summary">
        <span>敏感配置已排除 <strong>{report.skipped.sensitiveSettings}</strong></span>
        <span>同名配置已保留 <strong>{report.skipped.existingSettings}</strong></span>
        <span>孤立分镜已跳过 <strong>{report.skipped.orphanStoryboards}</strong></span>
      </div>

      {report.sensitiveSettingKeys.length > 0 && (
        <details className="legacy-details">
          <summary>查看已排除的配置键</summary>
          <div className="legacy-key-list">
            {report.sensitiveSettingKeys.map((key) => <code key={key}>{key}</code>)}
          </div>
        </details>
      )}

      {displayedMappings.length > 0 && (
        <details className="legacy-details">
          <summary>查看项目 ID 映射</summary>
          <div className="legacy-mapping-list">
            {displayedMappings.map(([oldId, newId]) => <code key={oldId}>{oldId} → {newId}</code>)}
            {Object.keys(report.projectIdMap).length > displayedMappings.length && <span>仅显示前 50 项</span>}
          </div>
        </details>
      )}

      {report.warnings.map((warning) => <div className="legacy-warning" key={warning}>{warning}</div>)}
    </div>
  );
}

export function LegacyImportPanel(): ReactElement {
  const [sourcePath, setSourcePath] = useState("");
  const [report, setReport] = useState<LegacyImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const chooseAndPreview = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const selected = await window.offline.legacyImport.selectSource();
      if (!selected) return;
      setSourcePath(selected);
      setReport(await window.offline.legacyImport.preview(selected));
    } catch (reason) {
      setReport(null);
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async (): Promise<void> => {
    setConfirming(false);
    setBusy(true);
    setError("");
    try {
      setReport(await window.offline.legacyImport.run(sourcePath));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const canImport = Boolean(report?.dryRun && !report.alreadyImported && !busy);

  return (
    <section className="settings-section legacy-import-section">
      <div className="settings-heading">
        <h2>旧版数据迁移</h2>
        <span>database.db</span>
      </div>
      <div className="legacy-import-content">
        <div className="legacy-source-row">
          <div className="legacy-source-path" title={sourcePath}>
            <Database size={17} />
            <code>{sourcePath || "尚未选择数据库"}</code>
          </div>
          <button className="secondary-button" disabled={busy} onClick={() => void chooseAndPreview()}>
            <FolderOpen size={17} />
            {busy ? "正在检查" : "选择并预览"}
          </button>
          <button className="primary-button" disabled={!canImport} onClick={() => setConfirming(true)}>
            <Import size={17} />
            导入
          </button>
        </div>

        {error && <div className="error-banner legacy-error">{error}</div>}
        {report && <ImportReport report={report} />}
      </div>

      {confirming && report && (
        <div className="legacy-modal-backdrop" role="presentation">
          <div className="legacy-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="legacy-confirm-title">
            <div className="legacy-confirm-title">
              <ShieldCheck size={20} />
              <h3 id="legacy-confirm-title">确认导入旧版数据</h3>
              <button className="icon-button" title="关闭" aria-label="关闭" onClick={() => setConfirming(false)}>
                <X size={18} />
              </button>
            </div>
            <p>
              将写入 {report.wouldImport.projects} 个项目、{report.wouldImport.storyboards} 条分镜和 {report.wouldImport.settings} 项配置。
              已识别的敏感配置不会导入。
            </p>
            <div className="legacy-confirm-actions">
              <button className="secondary-button" onClick={() => setConfirming(false)}>取消</button>
              <button className="primary-button" onClick={() => void runImport()}>
                <Import size={17} />
                确认导入
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
