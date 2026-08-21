import { useEffect, useState, type ReactElement } from "react";
import { DatabaseBackup, RefreshCcw, ShieldCheck } from "lucide-react";
import type { BackupRestoreStatus, BackupRestoreSummary, BackupSummary, BackupValidationSummary } from "../../../shared/contracts";

export function BackupPanel(): ReactElement {
  const [busy, setBusy] = useState<"create" | "validate" | "restore" | null>(null);
  const [created, setCreated] = useState<BackupSummary | null>(null);
  const [validation, setValidation] = useState<BackupValidationSummary | null>(null);
  const [restored, setRestored] = useState<BackupRestoreSummary | null>(null);
  const [restoreStatus, setRestoreStatus] = useState<BackupRestoreStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.offline.backup.restoreStatus().then(setRestoreStatus).catch((reason) => setError(String(reason)));
  }, []);

  const create = async (): Promise<void> => {
    setBusy("create");
    setError("");
    try { setCreated(await window.offline.backup.create()); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(null); }
  };

  const validate = async (): Promise<void> => {
    setBusy("validate");
    setError("");
    try { setValidation(await window.offline.backup.validate()); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(null); }
  };

  const restore = async (): Promise<void> => {
    if (!confirm("恢复会替换当前本地数据库和备份中包含的项目资产，应用将自动重启。继续选择备份？")) return;
    setBusy("restore");
    setError("");
    try { setRestored(await window.offline.backup.restore()); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(null); }
  };

  return (
    <section className="settings-section">
      <div className="settings-heading"><h2>备份与迁移</h2><span>SQLite + assets</span></div>
      <div className="backup-panel">
        <div className="backup-actions">
          <button className="secondary-button" disabled={busy !== null} onClick={() => void create()}><DatabaseBackup size={17} /> 创建完整备份</button>
          <button className="secondary-button" disabled={busy !== null} onClick={() => void validate()}><ShieldCheck size={17} /> 校验备份</button>
          <button className="secondary-button danger-outline" disabled={busy !== null} onClick={() => void restore()}><RefreshCcw size={17} /> 恢复备份并重启</button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {created && <div className="backup-result success-banner"><strong>备份完成</strong><code title={created.backupPath}>{created.backupPath}</code><span>{created.totalFiles} 个文件 · {(created.totalBytes / 1024 / 1024).toFixed(1)} MB · {created.protectedSettingCount} 个受保护配置跨电脑需重填</span></div>}
        {created?.warnings.map((warning) => <div className="warning-banner" key={warning}>{warning}</div>)}
        {validation && <div className={validation.valid ? "backup-result success-banner" : "backup-result error-banner"}><strong>{validation.valid ? "备份校验通过" : "备份校验失败"}</strong><code title={validation.backupPath}>{validation.backupPath}</code><span>{validation.totalFiles} 个文件 · SQLite {validation.databaseHealthy ? "正常" : "异常"}</span>{validation.errors.map((message) => <span key={message}>{message}</span>)}</div>}
        {validation?.warnings.map((warning) => <div className="warning-banner" key={warning}>{warning}</div>)}
        {restored && <div className="backup-result warning-banner"><strong>恢复已准备，应用即将重启</strong><code title={restored.backupPath}>{restored.backupPath}</code><span>已改写 {restored.rewrittenPathCount} 个项目路径{restored.requiresSecretReentry ? "；API Key/Secret 已清空，重启后请重新填写" : ""}</span></div>}
        {restored?.warnings.map((warning) => <div className="warning-banner" key={warning}>{warning}</div>)}
        {restoreStatus && <div className={restoreStatus.status === "applied" ? "backup-result success-banner" : "backup-result error-banner"}><strong>{restoreStatus.status === "applied" ? "上次恢复成功" : "上次恢复失败"}</strong><span>{restoreStatus.message}</span>{restoreStatus.rollbackPaths.map((path) => <code title={path} key={path}>回滚副本：{path}</code>)}</div>}
      </div>
    </section>
  );
}
