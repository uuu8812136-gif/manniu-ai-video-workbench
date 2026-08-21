import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { Activity, ArrowDown, ArrowUp, BellRing, ClipboardPaste, Copy, Eraser, FolderOpen, KeyRound, LockKeyhole, LogIn, Plus, PlugZap, RefreshCw, RotateCcw, Save, Send, Trash2 } from "lucide-react";
import { LegacyImportPanel } from "../components/LegacyImportPanel";
import { BackupPanel } from "../components/BackupPanel";
import { ModalDialog } from "../components/ModalDialog";
import type {
  MediaHealth,
  ModelProbePrefix,
  ModelProbeResult,
  ViduAccount,
  ViduAccountStatus,
  ViduJwtImportLineResult,
  ViduSubjectClipboardStatus,
  ViduSubjectOperationResult,
  WebhookEvent,
} from "../../../shared/contracts";
import {
  checkAccountsConcurrently,
  deleteAccountsContinuing,
  pointsAccountIds,
  prepareViduJwtImportLines,
  shouldClearViduJwtInput,
  viduAccountIssueTags,
  viduAccountPoolLocks,
} from "./vidu-account-page-state";
import {
  parseSettingKeyRows,
  pasteSettingKeyRows,
  removeSettingKeyRow,
  replaceSettingKeyRow,
  serializeSettingKeyRows,
} from "./settings-key-state";
import type { SettingsSection } from "../lib/app-route";
import { settingsTabs } from "./settings-tabs";

type ViduJwtUiResult = Omit<ViduJwtImportLineResult, "status"> & {
  status: ViduJwtImportLineResult["status"] | "pending" | "running";
};

type ViduSubjectUiStatus = {
  label: string;
  result?: ViduSubjectOperationResult;
};

function SettingsSaveAction({ busy, onSave }: { busy: boolean; onSave(): void }): ReactElement {
  return <div className="settings-panel-save"><button className="primary-button" disabled={busy} onClick={onSave}><Save size={16} /> 保存</button></div>;
}

type FormState = {
  infer_api_base_url: string;
  infer_api_key: string;
  infer_api_keys: string;
  infer_model: string;
  infer_protocol: string;
  infer_thinking: string;
  infer_concurrency_per_key: string;
  infer_max_output_tokens: string;
  infer_output_dir: string;
  text_polish_api_base_url: string;
  text_polish_api_key: string;
  text_polish_api_keys: string;
  text_polish_model: string;
  text_polish_protocol: string;
  text_polish_thinking: string;
  text_polish_concurrency_per_key: string;
  opening_output_dir: string;
  text_polish_output_dir: string;
  imagegen_api_base_url: string;
  imagegen_api_key: string;
  imagegen_api_keys: string;
  imagegen_model: string;
  imagegen_provider: string;
  imagegen_concurrency_per_key: string;
  imagegen_output_dir: string;
  video_api_base_url: string;
  video_provider: string;
  video_api_key: string;
  video_api_keys: string;
  video_api_key_header: string;
  video_concurrency_per_key: string;
  video_model: string;
  video_submit_path: string;
  video_status_path: string;
  video_poll_method: string;
  video_poll_interval_ms: string;
  video_request_timeout_ms: string;
  video_timeout_ms: string;
  video_download_timeout_ms: string;
  video_max_download_mb: string;
  video_result_send_auth: string;
  vidu_model: string;
  vidu_use_credits: string;
  vidu_account_dispatch_mode: string;
  vidu_poll_interval_ms: string;
  vidu_default_account_id: string;
  project_base_folder: string;
  jianying_draft_path: string;
  ffmpeg_path: string;
  ffprobe_path: string;
  webhook_url: string;
  webhook_enabled: string;
  webhook_events: string;
};

const initial: FormState = {
  infer_api_base_url: "https://api.deepseek.com",
  infer_api_key: "",
  infer_api_keys: "",
  infer_model: "deepseek-v4-pro",
  infer_protocol: "chat",
  infer_thinking: "disabled",
  infer_concurrency_per_key: "2",
  infer_max_output_tokens: "",
  infer_output_dir: "",
  text_polish_api_base_url: "https://ark.cn-beijing.volces.com/api/v3",
  text_polish_api_key: "",
  text_polish_api_keys: "",
  text_polish_model: "doubao-seed-2-0-pro-260215",
  text_polish_protocol: "responses",
  text_polish_thinking: "auto",
  text_polish_concurrency_per_key: "2",
  opening_output_dir: "",
  text_polish_output_dir: "",
  imagegen_api_base_url: "https://www.geeknow.top/v1",
  imagegen_api_key: "",
  imagegen_api_keys: "",
  imagegen_model: "gpt-image-2",
  imagegen_provider: "openai",
  imagegen_concurrency_per_key: "2",
  imagegen_output_dir: "",
  video_api_base_url: "http://127.0.0.1:8188/v1",
  video_provider: "vidu-browser",
  video_api_key: "",
  video_api_keys: "",
  video_api_key_header: "",
  video_concurrency_per_key: "2",
  video_model: "",
  video_submit_path: "videos/generations",
  video_status_path: "videos/{taskId}",
  video_poll_method: "GET",
  video_poll_interval_ms: "2000",
  video_request_timeout_ms: "30000",
  video_timeout_ms: "1800000",
  video_download_timeout_ms: "600000",
  video_max_download_mb: "2048",
  video_result_send_auth: "false",
  vidu_model: "Q3",
  vidu_use_credits: "true",
  vidu_account_dispatch_mode: "sequential",
  vidu_poll_interval_ms: "5000",
  vidu_default_account_id: "",
  project_base_folder: "",
  jianying_draft_path: "",
  ffmpeg_path: "ffmpeg",
  ffprobe_path: "ffprobe",
  webhook_url: "",
  webhook_enabled: "false",
  webhook_events: "",
};

const secretLabels: Record<string, string> = {
  infer_api_key: "小说转分镜主 Key",
  infer_api_keys: "小说转分镜备用 Keys",
  text_polish_api_key: "捋文主 Key",
  text_polish_api_keys: "捋文备用 Keys",
  imagegen_api_key: "生图主 Key",
  imagegen_api_keys: "生图备用 Keys",
  video_api_key: "视频主 Key",
  video_api_keys: "视频备用 Keys",
  webhook_url: "企业微信 Webhook URL",
};

const webhookEventLabels: Array<{ value: WebhookEvent; label: string }> = [
  { value: "error", label: "分镜失败" },
  { value: "complete", label: "项目全部完成" },
  { value: "throttle", label: "Vidu 队列拥塞" },
  { value: "quota", label: "账号额度用完" },
  { value: "batch", label: "批量队列完成" },
];

export function SettingsPage({
  focusSection,
  onSelectSection,
}: {
  focusSection?: SettingsSection;
  onSelectSection?(section: SettingsSection): void;
}): ReactElement {
  const [form, setForm] = useState(initial);
  const [activeTab, setActiveTab] = useState<SettingsSection>(focusSection ?? "browsers");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [mediaHealth, setMediaHealth] = useState<MediaHealth | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [probeBusy, setProbeBusy] = useState<ModelProbePrefix | null>(null);
  const [probeResults, setProbeResults] = useState<Partial<Record<ModelProbePrefix, ModelProbeResult>>>({});
  const [needsReentry, setNeedsReentry] = useState<string[]>([]);
  const [inferKeyRows, setInferKeyRows] = useState<string[]>([""]);
  const [viduAccounts, setViduAccounts] = useState<ViduAccount[]>([]);
  const [viduStatuses, setViduStatuses] = useState<Record<string, ViduAccountStatus>>({});
  const [viduClipboardStatus, setViduClipboardStatus] = useState<ViduSubjectClipboardStatus>({ count: 0, copiedAt: null, sourceAccountName: null });
  const [viduSubjectStatuses, setViduSubjectStatuses] = useState<Record<string, ViduSubjectUiStatus>>({});
  const [viduActionMessages, setViduActionMessages] = useState<Record<string, string>>({});
  const [viduSubjectClearAccount, setViduSubjectClearAccount] = useState<ViduAccount | null>(null);
  const [viduSubjectClearConfirmation, setViduSubjectClearConfirmation] = useState("");
  const [viduBusy, setViduBusy] = useState<string | null>(null);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [newViduName, setNewViduName] = useState("");
  const [newViduType, setNewViduType] = useState<"member" | "points">("member");
  const [newViduQuota, setNewViduQuota] = useState(200);
  const [showViduCreator, setShowViduCreator] = useState(false);
  const [viduCreatorMode, setViduCreatorMode] = useState<"single" | "batch">("single");
  const [viduJwtText, setViduJwtText] = useState("");
  const [viduSsuid, setViduSsuid] = useState("");
  const [viduJwtResults, setViduJwtResults] = useState<ViduJwtUiResult[]>([]);
  const [generationStatusKnown, setGenerationStatusKnown] = useState(false);
  const [accountMutationLockCount, setAccountMutationLockCount] = useState(0);
  const [accountDestructiveLockCount, setAccountDestructiveLockCount] = useState(0);
  const autoCheckedViduAccountIds = useRef("");

  useEffect(() => {
    if (!focusSection) return;
    setActiveTab(focusSection);
  }, [focusSection]);

  const selectTab = (section: SettingsSection): void => {
    setActiveTab(section);
    setMessage("");
    setError("");
    onSelectSection?.(section);
  };

  const selectTabFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const lastIndex = settingsTabs.length - 1;
    const nextIndex = event.key === "ArrowRight"
      ? (index + 1) % settingsTabs.length
      : event.key === "ArrowLeft"
        ? (index - 1 + settingsTabs.length) % settingsTabs.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? lastIndex
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextTab = settingsTabs[nextIndex];
    selectTab(nextTab.key);
    window.requestAnimationFrame(() => document.getElementById(`settings-tab-${nextTab.key}`)?.focus());
  };

  const accountMutationLocked = !generationStatusKnown || accountMutationLockCount > 0 || viduBusy !== null;
  const accountDestructiveLocked = !generationStatusKnown || accountDestructiveLockCount > 0 || viduBusy !== null;
  const pointAccountIds = pointsAccountIds(viduAccounts);

  useEffect(() => {
    void Promise.all([window.offline.settings.list(), window.offline.settings.status(), window.offline.vidu.listAccounts(), window.offline.app.paths(), window.offline.vidu.subjectClipboardStatus()])
      .then(([values, status, accounts, paths, subjectClipboard]) => {
        setForm((current) => ({
          ...current,
          ...values,
          jianying_draft_path: values.jianying_draft_path?.trim() || paths.jianyingDrafts,
        }));
        setNeedsReentry(status.needsReentry);
        setInferKeyRows(parseSettingKeyRows(values.infer_api_key ?? "", values.infer_api_keys ?? ""));
        setViduAccounts(accounts);
        setViduClipboardStatus(subjectClipboard);
      })
      .catch((reason) => setError(String(reason)));
  }, []);

  useEffect(() => {
    let disposed = false;
    let reportedFailure = false;
    const refreshGenerationState = async (): Promise<void> => {
      try {
        const locks = viduAccountPoolLocks(await window.offline.jobs.list());
        if (disposed) return;
        setAccountMutationLockCount(locks.mutation.length);
        setAccountDestructiveLockCount(locks.destructive.length);
        setGenerationStatusKnown(true);
        reportedFailure = false;
      } catch (reason) {
        if (disposed || reportedFailure) return;
        reportedFailure = true;
        setGenerationStatusKnown(false);
        setError(`读取生成任务状态失败：${reason instanceof Error ? reason.message : String(reason)}`);
      }
    };
    void refreshGenerationState();
    const timer = window.setInterval(() => void refreshGenerationState(), 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const canEditAccountPool = (kind: "mutation" | "destructive" | "delete" = "mutation", accountId?: string): boolean => {
    if (viduBusy !== null) {
      const reason = "正在处理另一个 Vidu 账号操作，请稍后再试";
      setError(reason);
      if (accountId) setViduActionMessages((current) => ({ ...current, [accountId]: reason }));
      return false;
    }
    const locked = kind === "delete"
      ? false
      : kind === "destructive"
        ? accountDestructiveLocked
        : accountMutationLocked;
    if (locked) {
      const reason = generationStatusKnown
          ? kind === "destructive"
          ? "视频任务运行或暂停期间不能删除 Vidu 账号"
          : "视频生成任务执行期间不能修改 Vidu 账号池；暂停后可以修改"
        : "正在读取生成任务状态，请稍后再操作账号池";
      setError(reason);
      if (accountId) setViduActionMessages((current) => ({ ...current, [accountId]: reason }));
      return false;
    }
    return true;
  };

  const set = (key: keyof FormState, value: string): void => setForm((current) => ({ ...current, [key]: value }));

  const syncInferKeyRows = (rows: string[]): void => {
    const normalized = rows.length > 0 ? rows.slice(0, 100) : [""];
    const serialized = serializeSettingKeyRows(normalized);
    setInferKeyRows(normalized);
    setForm((current) => ({ ...current, infer_api_key: serialized.primary, infer_api_keys: serialized.backups }));
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await Promise.all(Object.entries(form).map(([key, value]) => window.offline.settings.set(key, value)));
      setNeedsReentry((await window.offline.settings.status()).needsReentry);
      setMessage("设置已保存");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const selectDirectory = async (
    key: "project_base_folder" | "jianying_draft_path" | "infer_output_dir" | "opening_output_dir" | "text_polish_output_dir" | "imagegen_output_dir",
    title: string,
  ): Promise<void> => {
    const path = await window.offline.files.pickDirectory(title);
    if (path) set(key, path);
  };

  const selectExecutable = async (key: "ffmpeg_path" | "ffprobe_path"): Promise<void> => {
    const path = await window.offline.files.pickFile("executable");
    if (path) set(key, path);
  };

  const checkMedia = async (): Promise<void> => {
    setMediaBusy(true);
    setError("");
    try {
      setMediaHealth(await window.offline.media.health({
        ffmpegPath: form.ffmpeg_path.trim() || "ffmpeg",
        ffprobePath: form.ffprobe_path.trim() || "ffprobe",
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMediaBusy(false);
    }
  };

  const testModel = async (prefix: ModelProbePrefix): Promise<void> => {
    setProbeBusy(prefix);
    setError("");
    try {
      await Promise.all(Object.entries(form).map(([key, value]) => window.offline.settings.set(key, value)));
      setNeedsReentry((await window.offline.settings.status()).needsReentry);
      const result = await window.offline.models.probe(prefix);
      setProbeResults((current) => ({ ...current, [prefix]: result }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProbeBusy(null);
    }
  };

  const probeResult = (prefix: ModelProbePrefix): ReactElement | null => {
    const result = probeResults[prefix];
    if (!result) return null;
    return (
      <span className={result.ok ? "health-ok" : "health-error"}>
        {result.message} · {result.status ?? "无响应"} · {result.latencyMs}ms
      </span>
    );
  };

  const addViduAccount = async (): Promise<void> => {
    if (!canEditAccountPool()) return;
    setViduBusy("create");
    setError("");
    try {
      const account = await window.offline.vidu.createAccount({
        name: newViduName.trim() || `Vidu 账号 ${viduAccounts.length + 1}`,
        accountType: newViduType,
        defaultQuota: newViduQuota,
      });
      setViduAccounts((current) => [...current, account]);
      setNewViduName("");
      if (!form.vidu_default_account_id) set("vidu_default_account_id", account.id);
      setMessage(`已添加“${account.name}”，请点击登录打开 Vidu`);
      setShowViduCreator(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setViduBusy(null);
    }
  };

  const checkViduAccount = async (account: ViduAccount): Promise<void> => {
    if (viduBusy !== null) return;
    setViduBusy(`check:${account.id}`);
    setError("");
    try {
      const status = await window.offline.vidu.checkAccount(account.id);
      setViduStatuses((current) => ({ ...current, [account.id]: status }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setViduBusy(null);
    }
  };

  const checkAllViduAccounts = async (): Promise<void> => {
    if (viduBusy !== null || viduAccounts.length === 0) return;
    setViduBusy("check-all");
    setError("");
    try {
      const settled = await checkAccountsConcurrently(
        viduAccounts.map(({ id }) => id),
        (accountId) => window.offline.vidu.checkAccount(accountId),
        10,
        (result, index) => {
          const account = viduAccounts[index];
          const status: ViduAccountStatus = result.status === "fulfilled"
            ? result.value
            : {
                accountId: account.id,
                status: "unknown",
                httpStatus: null,
                message: `检测失败：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
              };
          setViduStatuses((current) => ({ ...current, [account.id]: status }));
        },
      );
      const statuses: Record<string, ViduAccountStatus> = {};
      const failures: string[] = [];
      settled.forEach((result, index) => {
        const account = viduAccounts[index];
        if (result.status === "fulfilled") statuses[account.id] = result.value;
        else failures.push(`${account.name}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      });
      setViduStatuses((current) => ({ ...current, ...statuses }));
      const online = Object.values(statuses).filter((status) => status.status === "logged-in").length;
      const withCredits = Object.values(statuses).filter((status) => status.availableCredits !== null && status.availableCredits !== undefined).length;
      setMessage(`账号检测完成：${online}/${viduAccounts.length} 在线，${withCredits} 个返回积分余额`);
      if (failures.length > 0) setError(`${failures.length} 个账号检测失败：${failures.join("；")}`);
    } finally {
      setViduBusy(null);
    }
  };

  useEffect(() => {
    const enabledAccountIds = viduAccounts.filter((account) => account.enabled).map((account) => account.id);
    const signature = enabledAccountIds.join(",");
    if (!generationStatusKnown || viduBusy !== null || !signature || autoCheckedViduAccountIds.current === signature) return;
    autoCheckedViduAccountIds.current = signature;
    void checkAllViduAccounts();
  }, [generationStatusKnown, viduAccounts, viduBusy]);

  const openViduAccount = async (account: ViduAccount): Promise<void> => {
    if (!canEditAccountPool()) return;
    setViduBusy(`open:${account.id}`);
    setError("");
    try {
      await window.offline.vidu.openLogin(account.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setViduBusy(null);
    }
  };

  const copyViduSubjectLibrary = async (account: ViduAccount): Promise<void> => {
    if (!canEditAccountPool()) return;
    setViduBusy(`subjects-copy:${account.id}`);
    setError("");
    setViduSubjectStatuses((current) => ({ ...current, [account.id]: { label: "正在读取全部自建主体…" } }));
    try {
      const status = await window.offline.vidu.copySubjectLibrary(account.id);
      setViduClipboardStatus(status);
      const label = status.count > 0
        ? `已复制 ${status.count} 个主体到本地剪贴板`
        : "当前账号没有自建主体，剪贴板已更新为空";
      setViduSubjectStatuses((current) => ({ ...current, [account.id]: { label } }));
      setMessage(label);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setViduSubjectStatuses((current) => ({ ...current, [account.id]: { label: `复制失败：${detail}` } }));
      setError(detail);
    } finally {
      setViduBusy(null);
    }
  };

  const pasteViduSubjectLibrary = async (account: ViduAccount): Promise<void> => {
    if (!canEditAccountPool()) return;
    setViduBusy(`subjects-paste:${account.id}`);
    setError("");
    setViduSubjectStatuses((current) => ({ ...current, [account.id]: { label: `正在粘贴 ${viduClipboardStatus.count} 个主体…` } }));
    try {
      const result = await window.offline.vidu.pasteSubjectLibrary(account.id);
      const label = `粘贴完成：成功 ${result.success}，失败 ${result.failed}，共 ${result.total}`;
      setViduSubjectStatuses((current) => ({ ...current, [account.id]: { label, result } }));
      if (result.failed > 0) setError(`${label}；可在该账号下查看失败明细`);
      else setMessage(label);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setViduSubjectStatuses((current) => ({ ...current, [account.id]: { label: `粘贴失败：${detail}` } }));
      setError(detail);
    } finally {
      setViduBusy(null);
    }
  };

  const requestClearViduSubjectLibrary = (account: ViduAccount): void => {
    if (!canEditAccountPool("delete", account.id)) return;
    setViduSubjectClearAccount(account);
    setViduSubjectClearConfirmation("");
  };

  const closeViduSubjectClear = (): void => {
    if (viduBusy !== null) return;
    setViduSubjectClearAccount(null);
    setViduSubjectClearConfirmation("");
  };

  const confirmClearViduSubjectLibrary = async (): Promise<void> => {
    const account = viduSubjectClearAccount;
    if (!account || viduSubjectClearConfirmation !== account.name) return;
    if (!canEditAccountPool("destructive", account.id)) return;
    setViduBusy(`subjects-clear:${account.id}`);
    setError("");
    setViduSubjectStatuses((current) => ({ ...current, [account.id]: { label: "正在逐项删除全部自建主体…" } }));
    try {
      const result = await window.offline.vidu.clearSubjectLibrary(account.id);
      const label = `清空完成：成功 ${result.success}，失败 ${result.failed}，共 ${result.total}`;
      setViduSubjectStatuses((current) => ({ ...current, [account.id]: { label, result } }));
      if (result.failed > 0) setError(`${label}；可在该账号下查看失败明细`);
      else setMessage(label);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setViduSubjectStatuses((current) => ({ ...current, [account.id]: { label: `清空失败：${detail}` } }));
      setError(detail);
    } finally {
      setViduBusy(null);
      setViduSubjectClearAccount(null);
      setViduSubjectClearConfirmation("");
    }
  };

  const setViduAccountEnabled = async (account: ViduAccount, enabled: boolean): Promise<void> => {
    await updateViduAccount(account, { enabled, clearDisabled: enabled });
  };

  const updateViduAccount = async (
    account: ViduAccount,
    input: Parameters<typeof window.offline.vidu.updateAccount>[1],
  ): Promise<void> => {
    if (!canEditAccountPool()) return;
    setViduBusy(`update:${account.id}`);
    setError("");
    try {
      const updated = await window.offline.vidu.updateAccount(account.id, input);
      setViduAccounts((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setViduAccounts(await window.offline.vidu.listAccounts());
    } finally {
      setViduBusy(null);
    }
  };

  const moveViduAccount = async (account: ViduAccount, direction: "up" | "down"): Promise<void> => {
    if (!canEditAccountPool()) return;
    setViduBusy(`move:${account.id}`);
    try {
      setViduAccounts(await window.offline.vidu.moveAccount(account.id, direction));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setViduBusy(null);
    }
  };

  const resetViduDailyUsage = async (): Promise<void> => {
    if (!canEditAccountPool()) return;
    if (!window.confirm("重置所有会员账号的今日用量？积分账号的累计用量不受影响。")) return;
    setViduBusy("reset-usage");
    try {
      setViduAccounts(await window.offline.vidu.resetDailyUsage());
      setMessage("会员账号今日用量已重置");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setViduBusy(null);
    }
  };

  const toggleWebhookEvent = (event: WebhookEvent, checked: boolean): void => {
    const selected = new Set(form.webhook_events.split(",").filter(Boolean));
    if (checked) selected.add(event);
    else selected.delete(event);
    set("webhook_events", webhookEventLabels.map(({ value }) => value).filter((value) => selected.has(value)).join(","));
  };

  const testWebhook = async (): Promise<void> => {
    if (!form.webhook_url.trim()) {
      setMessage("");
      setError("请先填写企业微信 Webhook URL");
      return;
    }
    setNotificationBusy(true);
    setMessage("");
    setError("");
    try {
      await Promise.all([
        window.offline.settings.set("webhook_url", form.webhook_url),
        window.offline.settings.set("webhook_enabled", form.webhook_enabled),
        window.offline.settings.set("webhook_events", form.webhook_events),
      ]);
      await window.offline.notifications.test(form.webhook_url);
      setMessage("企业微信测试消息发送成功");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setNotificationBusy(false);
    }
  };

  const deleteViduAccount = async (account: ViduAccount): Promise<void> => {
    if (!canEditAccountPool("destructive", account.id)) return;
    if (!window.confirm(`删除“${account.name}”及其本地 Vidu 登录会话？`)) return;
    setViduBusy(`delete:${account.id}`);
    setError("");
    setViduActionMessages((current) => ({ ...current, [account.id]: "正在删除账号和本地登录会话…" }));
    try {
      await window.offline.vidu.deleteAccount(account.id);
      setViduAccounts((current) => current.filter((item) => item.id !== account.id));
      setViduStatuses((current) => {
        const next = { ...current };
        delete next[account.id];
        return next;
      });
      if (form.vidu_default_account_id === account.id) set("vidu_default_account_id", "");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setViduActionMessages((current) => ({ ...current, [account.id]: `删除失败：${message}` }));
    } finally {
      setViduBusy(null);
    }
  };

  const closeViduCreator = (): void => {
    if (viduBusy !== null) return;
    setShowViduCreator(false);
    setViduCreatorMode("single");
    setNewViduName("");
    setNewViduType("member");
    setNewViduQuota(200);
    setViduJwtText("");
    setViduSsuid("");
    setViduJwtResults([]);
  };

  const deleteAllPointsAccounts = async (): Promise<void> => {
    if (!canEditAccountPool("destructive") || pointAccountIds.length === 0) return;
    if (!window.confirm(`删除全部 ${pointAccountIds.length} 个积分账号及其本地 Vidu 登录会话？会员账号会保留。`)) return;
    setViduBusy("delete-points");
    setError("");
    setMessage("");
    try {
      const result = await deleteAccountsContinuing(pointAccountIds, (accountId) => window.offline.vidu.deleteAccount(accountId));
      setViduAccounts(await window.offline.vidu.listAccounts());
      setViduStatuses((current) => Object.fromEntries(
        Object.entries(current).filter(([accountId]) => !result.deletedIds.includes(accountId)),
      ));
      if (result.deletedIds.includes(form.vidu_default_account_id)) set("vidu_default_account_id", "");
      if (result.deletedIds.length > 0) setMessage(`已删除 ${result.deletedIds.length} 个积分账号，会员账号已保留`);
      if (result.failures.length > 0) setError(`${result.failures.length} 个积分账号删除失败并已保留：${result.failures.map(({ accountId, error }) => `${accountId}（${error}）`).join("；")}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setViduAccounts(await window.offline.vidu.listAccounts());
    } finally {
      setViduBusy(null);
    }
  };

  const importViduJwtAccounts = async (): Promise<void> => {
    if (!canEditAccountPool()) return;
    if (!viduJwtText.trim()) {
      setError("请粘贴至少一个 Vidu JWT");
      return;
    }
    setViduBusy("jwt-import");
    setError("");
    setMessage("");
    const lines = prepareViduJwtImportLines(viduJwtText);
    setViduJwtResults(lines.map((line) => ({
      lineNumber: line.lineNumber,
      maskedToken: "[JWT_REDACTED]",
      status: line.status === "ready" ? "pending" : "failed",
      message: line.message,
      account: null,
    })));
    let clearInput = false;
    try {
      const completed: ViduJwtImportLineResult[] = lines
        .filter((line) => line.status === "failed")
        .map((line) => ({
          lineNumber: line.lineNumber,
          maskedToken: "[JWT_REDACTED]",
          status: "failed",
          message: line.message,
          account: null,
        }));
      for (const line of lines.filter((item) => item.status === "ready")) {
        setViduJwtResults((current) => current.map((item) => item.lineNumber === line.lineNumber
          ? { ...item, status: "running", message: "正在验证 Vidu 会话" }
          : item));
        let row: ViduJwtImportLineResult;
        try {
          const result = await window.offline.vidu.importJwtAccounts({
            tokens: line.token,
            ssuid: viduSsuid.trim() || undefined,
          });
          row = {
            ...(result.results[0] ?? {
              maskedToken: "[JWT_REDACTED]" as const,
              status: "failed" as const,
              message: "JWT 导入没有返回逐行结果",
              account: null,
            }),
            lineNumber: line.lineNumber,
          };
        } catch (reason) {
          row = {
            lineNumber: line.lineNumber,
            maskedToken: "[JWT_REDACTED]",
            status: "failed",
            message: reason instanceof Error ? reason.message : String(reason),
            account: null,
          };
        }
        completed.push(row);
        setViduJwtResults((current) => current.map((item) => item.lineNumber === line.lineNumber ? row : item));
      }
      const accounts = await window.offline.vidu.listAccounts();
      setViduAccounts(accounts);
      const firstImported = completed.find((item) => item.status === "success")?.account;
      if (!form.vidu_default_account_id && firstImported) set("vidu_default_account_id", firstImported.id);
      const success = completed.filter((item) => item.status === "success").length;
      clearInput = shouldClearViduJwtInput(completed);
      setMessage(`JWT 导入完成：成功 ${success}，失败 ${completed.length - success}，共 ${completed.length}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (clearInput) {
        setViduJwtText("");
        setViduSsuid("");
      }
      setViduBusy(null);
    }
  };

  const knownOnlineCount = viduAccounts.filter((account) => viduStatuses[account.id]?.status === "logged-in").length;
  const totalQuota = viduAccounts.reduce((sum, account) => sum + account.defaultQuota, 0);

  return (
    <div className="page-shell settings-page">
      <header className="page-header">
        <div>
          <h1>设置</h1>
          <p>本地模型与工作区</p>
        </div>
        <button className="primary-button" disabled={busy} onClick={() => void save()}>
          <Save size={17} /> 保存设置
        </button>
      </header>
      {message && <div className="success-banner">{message}</div>}
      {error && <div className="error-banner">{error}</div>}
      {needsReentry.length > 0 && (
        <div className="error-banner">
          部分 API Key 无法用当前 Windows 账户解密，请重新填写后保存：
          {needsReentry.map((key) => secretLabels[key] ?? key).join("、")}
        </div>
      )}

      <div className="settings-tablist" role="tablist" aria-label="设置分类" aria-orientation="horizontal">
        {settingsTabs.map((tab, index) => (
          <button
            className={activeTab === tab.key ? "settings-tab active" : "settings-tab"}
            id={`settings-tab-${tab.key}`}
            key={tab.key}
            role="tab"
            aria-controls={`settings-panel-${tab.key}`}
            aria-selected={activeTab === tab.key}
            tabIndex={activeTab === tab.key ? 0 : -1}
            onClick={() => selectTab(tab.key)}
            onKeyDown={(event) => selectTabFromKeyboard(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <section
        className="settings-section"
        id="settings-panel-inference"
        role="tabpanel"
        aria-labelledby="settings-tab-inference"
        hidden={activeTab !== "inference"}
      >
        <div className="settings-heading">
          <h2>小说转分镜</h2>
          <span>OpenAI-compatible</span>
        </div>
        <div className="settings-grid">
          <label>
            <span>API 地址</span>
            <input value={form.infer_api_base_url} onChange={(event) => set("infer_api_base_url", event.target.value)} />
          </label>
          <label>
            <span>模型</span>
            <input value={form.infer_model} onChange={(event) => set("infer_model", event.target.value)} />
          </label>
          <label>
            <span>协议</span>
            <select value="chat" disabled>
              <option value="chat">Chat Completions</option>
            </select>
          </label>
          <label>
            <span>思考模式</span>
            <select value="disabled" disabled>
              <option value="disabled">关闭</option>
            </select>
          </label>
          <label>
            <span>单次最大输出 Token</span>
            <input
              type="number"
              min="1"
              max="1000000"
              value="64000"
              disabled
            />
          </label>
          <div className="wide-field settings-key-field">
            <span>API Keys</span>
            <div className="settings-key-list">
              {inferKeyRows.map((key, index) => (
                <div className="settings-key-row" key={index}>
                  <input
                    type="password"
                    value={key}
                    placeholder={`sk-...（密钥 ${index + 1}）`}
                    autoComplete="new-password"
                    onChange={(event) => syncInferKeyRows(replaceSettingKeyRow(inferKeyRows, index, event.target.value))}
                    onPaste={(event) => {
                      const next = pasteSettingKeyRows(inferKeyRows, index, event.clipboardData.getData("text"));
                      if (!next) return;
                      event.preventDefault();
                      syncInferKeyRows(next);
                    }}
                  />
                  <button className="icon-button danger" title={`删除密钥 ${index + 1}`} disabled={inferKeyRows.length === 1 && !key} onClick={() => syncInferKeyRows(removeSettingKeyRow(inferKeyRows, index))}><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
            <button className="secondary-button settings-key-add" disabled={inferKeyRows.length >= 100} onClick={() => syncInferKeyRows([...inferKeyRows, ""])}><Plus size={15} /> 添加密钥</button>
          </div>
          <label>
            <span>每个 Key 并发数</span>
            <input
              type="number"
              min={1}
              max={8}
              value={form.infer_concurrency_per_key}
              onChange={(event) => set("infer_concurrency_per_key", event.target.value)}
            />
          </label>
          <label className="wide-field">
            <span>分镜输出目录</span>
            <div className="path-input-row"><input value={form.infer_output_dir} onChange={(event) => set("infer_output_dir", event.target.value)} /><button className="icon-button" title="选择分镜输出目录" onClick={() => void selectDirectory("infer_output_dir", "选择小说转分镜输出目录")}><FolderOpen size={17} /></button></div>
          </label>
        </div>
        <div className="model-probe-row">
          <button className="secondary-button" disabled={probeBusy !== null} onClick={() => void testModel("infer")}>
            <PlugZap size={16} /> 检查接口与鉴权
          </button>
          {probeResult("infer")}
        </div>
        <SettingsSaveAction busy={busy} onSave={() => void save()} />
      </section>

      <section
        className="settings-section"
        id="settings-panel-browsers"
        role="tabpanel"
        aria-labelledby="settings-tab-browsers"
        hidden={activeTab !== "browsers"}
      >
        <div className="settings-heading"><h2>视频生成</h2><span>{form.video_provider === "vidu-browser" ? "Vidu 浏览器" : "自定义 API"}</span></div>
        <div>
          <div className="segmented-control video-provider-control" role="group" aria-label="视频供应商">
            <button className={form.video_provider === "custom-api" ? "selected" : ""} onClick={() => set("video_provider", "custom-api")}>自定义 API</button>
            <button className={form.video_provider === "vidu-browser" ? "selected" : ""} onClick={() => set("video_provider", "vidu-browser")}>Vidu 浏览器</button>
          </div>
          {form.video_provider === "custom-api" && (
          <div className="settings-grid">
            <label><span>API 地址</span><input value={form.video_api_base_url} onChange={(event) => set("video_api_base_url", event.target.value)} /></label>
            <label><span>模型</span><input value={form.video_model} onChange={(event) => set("video_model", event.target.value)} /></label>
            <label className="wide-field"><span>主 API Key</span><input type="password" value={form.video_api_key} onChange={(event) => set("video_api_key", event.target.value)} autoComplete="new-password" /></label>
            <label className="wide-field"><span>备用 API Keys（每行一个）</span><textarea value={form.video_api_keys} onChange={(event) => set("video_api_keys", event.target.value)} /></label>
            <label><span>API Key Header</span><input value={form.video_api_key_header} placeholder="默认 Authorization: Bearer" onChange={(event) => set("video_api_key_header", event.target.value)} /></label>
            <label><span>每个 Key 并发数</span><input type="number" min={1} max={32} value={form.video_concurrency_per_key} onChange={(event) => set("video_concurrency_per_key", event.target.value)} /></label>
            <label><span>提交路径</span><input value={form.video_submit_path} onChange={(event) => set("video_submit_path", event.target.value)} /></label>
            <label><span>状态路径</span><input value={form.video_status_path} onChange={(event) => set("video_status_path", event.target.value)} /></label>
            <label><span>轮询方法</span><select value={form.video_poll_method} onChange={(event) => set("video_poll_method", event.target.value)}><option value="GET">GET</option><option value="POST">POST</option></select></label>
            <label><span>轮询间隔 (ms)</span><input type="number" min={250} value={form.video_poll_interval_ms} onChange={(event) => set("video_poll_interval_ms", event.target.value)} /></label>
            <label><span>单次请求超时 (ms)</span><input type="number" min={1000} value={form.video_request_timeout_ms} onChange={(event) => set("video_request_timeout_ms", event.target.value)} /></label>
            <label><span>任务超时 (ms)</span><input type="number" min={1000} value={form.video_timeout_ms} onChange={(event) => set("video_timeout_ms", event.target.value)} /></label>
            <label><span>下载超时 (ms)</span><input type="number" min={1000} value={form.video_download_timeout_ms} onChange={(event) => set("video_download_timeout_ms", event.target.value)} /></label>
            <label><span>视频上限 (MB)</span><input type="number" min={1} value={form.video_max_download_mb} onChange={(event) => set("video_max_download_mb", event.target.value)} /></label>
            <label className="checkbox-field wide-field">
              <input
                type="checkbox"
                checked={form.video_result_send_auth === "true"}
                onChange={(event) => set("video_result_send_auth", String(event.target.checked))}
              />
              <span>结果下载地址也需要 API 鉴权</span>
            </label>
          </div>
          )}
            <div className="vidu-settings">
              <div className="settings-grid">
                <label><span>模型</span><select value={form.vidu_model} onChange={(event) => set("vidu_model", event.target.value)}><option value="Q3">Q3</option><option value="Q2">Q2</option></select></label>
                <label><span>账号使用方式</span><select value={form.vidu_account_dispatch_mode} onChange={(event) => set("vidu_account_dispatch_mode", event.target.value)}><option value="sequential">单账号顺序使用</option><option value="parallel">多账号并行使用</option></select></label>
                <label><span>默认账号</span><select disabled={accountMutationLocked} value={form.vidu_default_account_id} onChange={(event) => set("vidu_default_account_id", event.target.value)}><option value="">自动选择已登录账号</option>{viduAccounts.filter((account) => account.enabled).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
                <label><span>轮询间隔 (ms)</span><input type="number" min={1000} value={form.vidu_poll_interval_ms} onChange={(event) => set("vidu_poll_interval_ms", event.target.value)} /></label>
                <label><span>任务超时 (ms)</span><input type="number" min={1000} value={form.video_timeout_ms} onChange={(event) => set("video_timeout_ms", event.target.value)} /></label>
                <label><span>下载超时 (ms)</span><input type="number" min={1000} value={form.video_download_timeout_ms} onChange={(event) => set("video_download_timeout_ms", event.target.value)} /></label>
                <label><span>视频上限 (MB)</span><input type="number" min={1} value={form.video_max_download_mb} onChange={(event) => set("video_max_download_mb", event.target.value)} /></label>
                <label className="checkbox-field wide-field"><input type="checkbox" checked={form.vidu_use_credits === "true"} onChange={(event) => set("vidu_use_credits", String(event.target.checked))} /><span>使用积分生成；关闭后使用错峰模式</span></label>
              </div>
              {(!generationStatusKnown || accountDestructiveLockCount > 0) && (
                <div className="vidu-account-lock-notice">
                  <LockKeyhole size={16} />
                  <span>{!generationStatusKnown
                    ? "正在读取视频任务状态，账号池暂时锁定"
                    : accountMutationLockCount > 0
                      ? `${accountMutationLockCount} 个视频任务正在等待或运行，账号池已锁定`
                      : `${accountDestructiveLockCount} 个视频任务已暂停，账号可编辑但暂不能删除`}</span>
                </div>
              )}
              <div className="vidu-account-heading">
                <strong>浏览器账号池</strong>
                <div className="vidu-account-heading-actions">
                  <button className="primary-button" disabled={accountMutationLocked} onClick={() => setShowViduCreator(true)}><Plus size={16} /> 添加账号</button>
                  <button className="secondary-button" disabled={viduBusy !== null || viduAccounts.length === 0} onClick={() => void checkAllViduAccounts()}><RefreshCw size={16} /> 查询登录与积分</button>
                  <button className="secondary-button" disabled={accountDestructiveLocked || pointAccountIds.length === 0} onClick={() => void deleteAllPointsAccounts()}><Trash2 size={16} /> 删除全部积分账号</button>
                  <button className="secondary-button" disabled={accountMutationLocked} onClick={() => void resetViduDailyUsage()}><RotateCcw size={16} /> 重置每日用量</button>
                </div>
              </div>
              <div className="vidu-subject-clipboard-status">
                <ClipboardPaste size={15} />
                <span>{viduClipboardStatus.count > 0
                  ? `本地主体剪贴板：${viduClipboardStatus.count} 个，来源“${viduClipboardStatus.sourceAccountName ?? "未知账号"}”`
                  : "本地主体剪贴板为空"}</span>
              </div>
              {viduAccounts.length > 0 && (
                <div className="vidu-usage-summary">
                  <span>今日可用 <strong>{viduAccounts.reduce((sum, account) => sum + (account.enabled ? Math.max(0, account.defaultQuota - account.usageCount) : 0), 0)}</strong> 次</span>
                  <span>{viduAccounts.filter((account) => account.enabled).length}/{viduAccounts.length} 启用</span>
                  <span title="以本页已检测的登录状态统计">{knownOnlineCount}/{viduAccounts.length} 在线</span>
                  <span>总额度 <strong>{totalQuota}</strong></span>
                </div>
              )}
              <div className="vidu-account-list">
                {viduAccounts.map((account, accountIndex) => {
                  const status = viduStatuses[account.id];
                  const subjectStatus = viduSubjectStatuses[account.id];
                  const actionMessage = viduActionMessages[account.id];
                  const issueTags = viduAccountIssueTags(account, status);
                  const usagePercent = Math.min(100, Math.round(account.usageCount / account.defaultQuota * 100));
                  const disabledLabel = account.disabledReason === "credits_exhausted"
                    ? "积分耗尽"
                    : account.disabledReason === "subject_limit"
                      ? "主体限频"
                      : account.disabledReason === "login_expired"
                        ? "登录过期"
                        : account.disabledReason === "manual"
                          ? "手动停用"
                          : "";
                  return (
                    <div className="vidu-account-row" key={account.id}>
                      <div className="vidu-account-identity">
                        <label className="vidu-account-enabled"><input disabled={accountMutationLocked} type="checkbox" checked={account.enabled} onChange={(event) => void setViduAccountEnabled(account, event.target.checked)} /><span>启用</span></label>
                        <input className="vidu-account-name" disabled={accountMutationLocked} value={account.name} onChange={(event) => setViduAccounts((current) => current.map((item) => item.id === account.id ? { ...item, name: event.target.value } : item))} onBlur={() => void updateViduAccount(account, { name: account.name })} />
                      </div>
                      <div className="vidu-account-config">
                        <select disabled={accountMutationLocked} value={account.accountType} onChange={(event) => void updateViduAccount(account, { accountType: event.target.value as "member" | "points" })}><option value="member">会员·日重置</option><option value="points">积分·累计</option></select>
                        <label><span>额度</span><input disabled={accountMutationLocked} type="number" min={1} max={500} value={account.defaultQuota} onChange={(event) => setViduAccounts((current) => current.map((item) => item.id === account.id ? { ...item, defaultQuota: Math.min(500, Math.max(1, Number(event.target.value) || 1)) } : item))} onBlur={() => void updateViduAccount(account, { defaultQuota: account.defaultQuota })} /></label>
                      </div>
                      <div className="vidu-account-usage">
                        <div><span>{account.accountType === "points" ? "累计用量" : "今日用量"}</span><strong>{account.usageCount}/{account.defaultQuota}</strong></div>
                        <span className="vidu-usage-track"><i style={{ width: `${usagePercent}%` }} /></span>
                      </div>
                      <div className="vidu-account-state">
                        <span className={`vidu-account-status ${status?.status ?? "unknown"}`}>{status?.message ?? "未检测"}</span>
                        {status?.availableCredits !== null && status?.availableCredits !== undefined && <span className="vidu-credit-balance">{status.availableCredits.toLocaleString("zh-CN")} 积分</span>}
                        {issueTags.length > 0 && <div className="account-issue-tags">{issueTags.map((issue) => <span className={`vidu-issue-tag ${issue.kind}`} title={issue.message} key={issue.kind}>{issue.label}</span>)}</div>}
                        {disabledLabel && <button className="account-disabled-reason" disabled={accountMutationLocked} title={account.disabledMessage ?? disabledLabel} onClick={() => void updateViduAccount(account, { enabled: true, clearDisabled: true })}>{disabledLabel} · 解除</button>}
                      </div>
                      <div className="vidu-account-order">
                        <button className="icon-button" title="上移账号" disabled={accountMutationLocked || accountIndex === 0} onClick={() => void moveViduAccount(account, "up")}><ArrowUp size={15} /></button>
                        <button className="icon-button" title="下移账号" disabled={accountMutationLocked || accountIndex === viduAccounts.length - 1} onClick={() => void moveViduAccount(account, "down")}><ArrowDown size={15} /></button>
                      </div>
                      <div className="vidu-account-actions">
                        <button className="secondary-button" disabled={accountMutationLocked} onClick={() => void openViduAccount(account)}><LogIn size={15} /> 登录</button>
                        <button className="icon-button" title="检测登录状态" disabled={viduBusy !== null} onClick={() => void checkViduAccount(account)}><RefreshCw size={16} /></button>
                        <button className="icon-button" title="复制该账号的全部自建主体" disabled={accountMutationLocked} onClick={() => void copyViduSubjectLibrary(account)}><Copy size={16} /></button>
                        <button className="icon-button" title={viduClipboardStatus.count > 0 ? `粘贴本地剪贴板中的 ${viduClipboardStatus.count} 个主体` : "本地主体剪贴板为空"} disabled={accountMutationLocked || viduClipboardStatus.count === 0} onClick={() => void pasteViduSubjectLibrary(account)}><ClipboardPaste size={16} /></button>
                        <button
                          className={`icon-button danger ${accountDestructiveLocked ? "explain-disabled" : ""}`}
                          title={accountDestructiveLocked ? "点击查看当前不能清空主体的原因" : "清空该账号的全部自建主体"}
                          aria-disabled={accountDestructiveLocked}
                          onClick={() => requestClearViduSubjectLibrary(account)}
                        ><Eraser size={16} /></button>
                        <button
                          className={`icon-button danger ${viduBusy !== null ? "explain-disabled" : ""}`}
                          title={viduBusy !== null ? "正在处理其他账号操作" : "删除账号和本地会话"}
                          aria-disabled={viduBusy !== null}
                          onClick={() => void deleteViduAccount(account)}
                        ><Trash2 size={16} /></button>
                      </div>
                      {actionMessage && <div className={`vidu-account-action-message ${actionMessage.startsWith("删除失败") ? "failed" : ""}`}>{actionMessage}</div>}
                      {subjectStatus && (
                        <div className={`vidu-subject-operation-status ${subjectStatus.result?.failed ? "failed" : ""}`}>
                          <span>{subjectStatus.label}</span>
                          {subjectStatus.result && subjectStatus.result.results.length > 0 && (
                            <details>
                              <summary>逐项结果</summary>
                              <div>{subjectStatus.result.results.map((item, index) => (
                                <span className={item.status} key={`${item.name}-${index}`}>{item.name}：{item.message}</span>
                              ))}</div>
                            </details>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {viduAccounts.length === 0 && <div className="empty-state compact">还没有 Vidu 浏览器账号</div>}
              </div>
            </div>
        </div>
        <SettingsSaveAction busy={busy} onSave={() => void save()} />
      </section>

      <section
        className="settings-section"
        id="settings-panel-novel-optimizer"
        role="tabpanel"
        aria-labelledby="settings-tab-novel-optimizer"
        hidden={activeTab !== "novel-optimizer"}
      >
        <div className="settings-heading">
          <h2>开头优化</h2>
          <span>复用推理设置</span>
        </div>
        <div className="settings-grid one-column">
          <label><span>输出目录</span><div className="path-input-row"><input value={form.opening_output_dir} onChange={(event) => set("opening_output_dir", event.target.value)} /><button className="icon-button" title="选择开头优化输出目录" onClick={() => void selectDirectory("opening_output_dir", "选择开头优化输出目录")}><FolderOpen size={17} /></button></div></label>
        </div>
        <SettingsSaveAction busy={busy} onSave={() => void save()} />
      </section>

      <section
        className="settings-section"
        id="settings-panel-text-polish"
        role="tabpanel"
        aria-labelledby="settings-tab-text-polish"
        hidden={activeTab !== "text-polish"}
      >
        <div className="settings-heading">
          <h2>捋文设置</h2>
          <span>Responses API</span>
        </div>
        <div className="settings-grid">
          <label>
            <span>API 地址</span>
            <input
              value={form.text_polish_api_base_url}
              onChange={(event) => set("text_polish_api_base_url", event.target.value)}
            />
          </label>
          <label>
            <span>模型</span>
            <input list="text-polish-model-presets" value={form.text_polish_model} onChange={(event) => set("text_polish_model", event.target.value)} />
            <datalist id="text-polish-model-presets">
              <option value="doubao-seed-2-0-pro-260215" />
              <option value="doubao-seed-2-1-pro-260628" />
            </datalist>
          </label>
          <label>
            <span>协议</span>
            <select value={form.text_polish_protocol} onChange={(event) => set("text_polish_protocol", event.target.value)}>
              <option value="responses">Responses</option>
              <option value="chat">Chat Completions</option>
            </select>
          </label>
          <label>
            <span>思考模式</span>
            <select value={form.text_polish_thinking} onChange={(event) => set("text_polish_thinking", event.target.value)}>
              <option value="auto">跟随模型</option>
              <option value="enabled">启用</option>
              <option value="disabled">关闭（更快）</option>
            </select>
          </label>
          <label className="wide-field">
            <span>主 API Key</span>
            <input
              type="password"
              value={form.text_polish_api_key}
              onChange={(event) => set("text_polish_api_key", event.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label className="wide-field">
            <span>备用 API Keys（每行一个）</span>
            <textarea value={form.text_polish_api_keys} onChange={(event) => set("text_polish_api_keys", event.target.value)} />
          </label>
          <label>
            <span>每个 Key 并发数</span>
            <input type="number" min={1} max={16} value={form.text_polish_concurrency_per_key} onChange={(event) => set("text_polish_concurrency_per_key", event.target.value)} />
          </label>
          <label className="wide-field"><span>输出目录</span><div className="path-input-row"><input value={form.text_polish_output_dir} onChange={(event) => set("text_polish_output_dir", event.target.value)} /><button className="icon-button" title="选择捋文输出目录" onClick={() => void selectDirectory("text_polish_output_dir", "选择捋文输出目录")}><FolderOpen size={17} /></button></div></label>
        </div>
        <div className="model-probe-row">
          <button className="secondary-button" disabled={probeBusy !== null} onClick={() => void testModel("text_polish")}>
            <PlugZap size={16} /> 检查接口与鉴权
          </button>
          {probeResult("text_polish")}
        </div>
        <SettingsSaveAction busy={busy} onSave={() => void save()} />
      </section>

      <section
        className="settings-section"
        id="settings-panel-imagegen"
        role="tabpanel"
        aria-labelledby="settings-tab-imagegen"
        hidden={activeTab !== "imagegen"}
      >
        <div className="settings-heading">
          <h2>出图设置</h2>
          <span>Images API</span>
        </div>
        <div className="settings-grid">
          <label>
            <span>服务协议</span>
            <select value={form.imagegen_provider} onChange={(event) => set("imagegen_provider", event.target.value)}>
              <option value="openai">OpenAI Images</option>
              <option value="gemini">Gemini 原生</option>
            </select>
          </label>
          <label>
            <span>API 地址</span>
            <input
              list="imagegen-api-presets"
              value={form.imagegen_api_base_url}
              onChange={(event) => set("imagegen_api_base_url", event.target.value)}
            />
            <datalist id="imagegen-api-presets">
              <option value="https://www.geeknow.top/v1" />
              <option value="https://yunwu.ai/v1" />
            </datalist>
          </label>
          <label>
            <span>模型</span>
            <input value={form.imagegen_model} onChange={(event) => set("imagegen_model", event.target.value)} />
          </label>
          <label className="wide-field">
            <span>主 API Key</span>
            <input
              type="password"
              value={form.imagegen_api_key}
              onChange={(event) => set("imagegen_api_key", event.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label className="wide-field">
            <span>备用 API Keys（每行一个）</span>
            <textarea value={form.imagegen_api_keys} onChange={(event) => set("imagegen_api_keys", event.target.value)} />
          </label>
          <label>
            <span>每个 Key 并发数</span>
            <input type="number" min={1} max={16} value={form.imagegen_concurrency_per_key} onChange={(event) => set("imagegen_concurrency_per_key", event.target.value)} />
          </label>
          <label className="wide-field"><span>生图输出目录</span><div className="path-input-row"><input value={form.imagegen_output_dir} onChange={(event) => set("imagegen_output_dir", event.target.value)} /><button className="icon-button" title="选择生图输出目录" onClick={() => void selectDirectory("imagegen_output_dir", "选择生图输出目录")}><FolderOpen size={17} /></button></div></label>
        </div>
        <div className="model-probe-row">
          <button className="secondary-button" disabled={probeBusy !== null} onClick={() => void testModel("imagegen")}>
            <PlugZap size={16} /> 检查接口与鉴权
          </button>
          {probeResult("imagegen")}
        </div>
        <SettingsSaveAction busy={busy} onSave={() => void save()} />
      </section>

      <section
        className="settings-section"
        id="settings-panel-jianying-tools"
        hidden={activeTab !== "jianying"}
      >
        <div className="settings-heading">
          <h2>本地媒体工具</h2>
          <span>FFmpeg / FFprobe</span>
        </div>
        <div className="settings-grid one-column">
          <label>
            <span>FFmpeg</span>
            <div className="path-input-row">
              <input value={form.ffmpeg_path} onChange={(event) => set("ffmpeg_path", event.target.value)} />
              <button className="icon-button" title="选择 FFmpeg" onClick={() => void selectExecutable("ffmpeg_path")}>
                <FolderOpen size={17} />
              </button>
            </div>
          </label>
          <label>
            <span>FFprobe</span>
            <div className="path-input-row">
              <input value={form.ffprobe_path} onChange={(event) => set("ffprobe_path", event.target.value)} />
              <button className="icon-button" title="选择 FFprobe" onClick={() => void selectExecutable("ffprobe_path")}>
                <FolderOpen size={17} />
              </button>
            </div>
          </label>
          <div className="media-health-actions">
            <button className="secondary-button" disabled={mediaBusy} onClick={() => void checkMedia()}>
              <Activity size={17} /> 检测媒体工具
            </button>
            {mediaHealth && (
              <div className="media-health-result">
                <span className={mediaHealth.ffmpeg.ok ? "health-ok" : "health-error"}>
                  FFmpeg：{mediaHealth.ffmpeg.version ?? mediaHealth.ffmpeg.error}
                </span>
                <span className={mediaHealth.ffprobe.ok ? "health-ok" : "health-error"}>
                  FFprobe：{mediaHealth.ffprobe.version ?? mediaHealth.ffprobe.error}
                </span>
              </div>
            )}
          </div>
        </div>
      </section>

      <section
        className="settings-section"
        id="settings-panel-folder"
        role="tabpanel"
        aria-labelledby="settings-tab-folder"
        hidden={activeTab !== "folder"}
      >
        <div className="settings-heading">
          <h2>项目文件夹</h2>
          <span>Windows</span>
        </div>
        <div className="settings-grid one-column">
          <label>
            <span>项目根目录</span>
            <div className="path-input-row">
              <input
                value={form.project_base_folder}
                onChange={(event) => set("project_base_folder", event.target.value)}
              />
              <button className="icon-button" title="选择项目根目录" onClick={() => void selectDirectory("project_base_folder", "选择项目根目录")}>
                <FolderOpen size={17} />
              </button>
            </div>
          </label>
        </div>
        <SettingsSaveAction busy={busy} onSave={() => void save()} />
      </section>

      <section
        className="settings-section"
        id="settings-panel-jianying"
        role="tabpanel"
        aria-labelledby="settings-tab-jianying"
        hidden={activeTab !== "jianying"}
      >
        <div className="settings-heading">
          <h2>剪映路径</h2>
          <span>Windows</span>
        </div>
        <div className="settings-grid one-column">
          <label>
            <span>剪映草稿目录</span>
            <div className="path-input-row">
              <input
                value={form.jianying_draft_path}
                onChange={(event) => set("jianying_draft_path", event.target.value)}
              />
              <button className="icon-button" title="选择剪映草稿目录" onClick={() => void selectDirectory("jianying_draft_path", "选择剪映草稿目录")}>
                <FolderOpen size={17} />
              </button>
            </div>
          </label>
        </div>
        <SettingsSaveAction busy={busy} onSave={() => void save()} />
      </section>

      <section
        className="settings-section"
        id="settings-panel-notifications"
        role="tabpanel"
        aria-labelledby="settings-tab-notifications"
        hidden={activeTab !== "notifications"}
      >
        <div className="settings-heading">
          <h2>通知设置</h2>
          <span>企业微信机器人</span>
        </div>
        <div className="notification-settings">
          <label className="notification-url-field">
            <span>Webhook URL</span>
            <input
              type="text"
              value={form.webhook_url}
              placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
              onChange={(event) => set("webhook_url", event.target.value)}
            />
          </label>
          <label className="toggle-line">
            <input type="checkbox" checked={form.webhook_enabled === "true"} onChange={(event) => set("webhook_enabled", String(event.target.checked))} />
            <span>启用通知</span>
          </label>
          <div className="notification-event-list">
            {webhookEventLabels.map((item) => (
              <label key={item.value}>
                <input
                  type="checkbox"
                  checked={form.webhook_events.split(",").includes(item.value)}
                  onChange={(event) => toggleWebhookEvent(item.value, event.target.checked)}
                />
                <span>{item.label}</span>
              </label>
            ))}
          </div>
          <div className="notification-actions">
            <button className="secondary-button" disabled={notificationBusy} onClick={() => void testWebhook()}>
              {notificationBusy ? <RefreshCw size={16} /> : <Send size={16} />} 发送测试消息
            </button>
            <span><BellRing size={15} /> 设置随页面顶部“保存设置”一并保存</span>
          </div>
        </div>
        <SettingsSaveAction busy={busy} onSave={() => void save()} />
      </section>

      <ModalDialog
        open={viduSubjectClearAccount !== null}
        title="清空账号主体库"
        description="此操作会永久删除该账号的全部自建主体，不能撤销。"
        busy={viduBusy !== null}
        onClose={closeViduSubjectClear}
        actions={<>
          <button className="secondary-button" disabled={viduBusy !== null} onClick={closeViduSubjectClear}>取消</button>
          <button
            className="danger-button"
            disabled={viduBusy !== null || !viduSubjectClearAccount || viduSubjectClearConfirmation !== viduSubjectClearAccount.name}
            onClick={() => void confirmClearViduSubjectLibrary()}
          ><Eraser size={16} /> 永久清空</button>
        </>}
      >
        {viduSubjectClearAccount && (
          <div className="vidu-subject-clear-confirmation">
            <div>
              <span>目标账号</span>
              <strong>{viduSubjectClearAccount.name}</strong>
            </div>
            <label>
              <span>输入完整账号名以确认</span>
              <input
                autoFocus
                disabled={viduBusy !== null}
                value={viduSubjectClearConfirmation}
                onChange={(event) => setViduSubjectClearConfirmation(event.target.value)}
                placeholder={viduSubjectClearAccount.name}
              />
            </label>
          </div>
        )}
      </ModalDialog>

      <ModalDialog
        open={showViduCreator}
        title="添加浏览器账号"
        description="添加单个账号，或批量导入积分账号 JWT"
        busy={viduBusy !== null}
        onClose={closeViduCreator}
        actions={<>
          <button className="secondary-button" disabled={viduBusy !== null} onClick={closeViduCreator}>取消</button>
          {viduCreatorMode === "single"
            ? <button className="primary-button" disabled={accountMutationLocked} onClick={() => void addViduAccount()}><Plus size={16} /> 添加</button>
            : <button className="primary-button" disabled={accountMutationLocked || !viduJwtText.trim()} onClick={() => void importViduJwtAccounts()}><KeyRound size={16} /> 开始导入</button>}
        </>}
      >
        <div className="vidu-account-modal">
          <div className="segmented-control vidu-account-modal-tabs" role="tablist" aria-label="账号添加方式">
            <button role="tab" aria-selected={viduCreatorMode === "single"} className={viduCreatorMode === "single" ? "selected" : ""} disabled={viduBusy !== null} onClick={() => { setViduCreatorMode("single"); setViduJwtResults([]); }}>单个添加</button>
            <button role="tab" aria-selected={viduCreatorMode === "batch"} className={viduCreatorMode === "batch" ? "selected" : ""} disabled={viduBusy !== null} onClick={() => setViduCreatorMode("batch")}>批量 JWT</button>
          </div>
          {viduCreatorMode === "single" ? (
            <div className="vidu-account-create">
              <label><span>账号名称</span><input autoFocus disabled={viduBusy !== null} value={newViduName} placeholder={`Vidu 账号 ${viduAccounts.length + 1}`} onChange={(event) => setNewViduName(event.target.value)} /></label>
              <label><span>类型</span><select disabled={viduBusy !== null} value={newViduType} onChange={(event) => { const value = event.target.value as "member" | "points"; setNewViduType(value); setNewViduQuota(value === "points" ? 46 : 200); }}><option value="member">会员账号（每日重置额度）</option><option value="points">积分账号（不重置）</option></select></label>
              <label><span>额度</span><input disabled={viduBusy !== null} type="number" min={1} max={500} value={newViduQuota} onChange={(event) => setNewViduQuota(Math.min(500, Math.max(1, Number(event.target.value) || 1)))} /></label>
            </div>
          ) : (
            <div className="vidu-jwt-import">
              <div className="vidu-jwt-fields">
                <label><span>积分账号 JWT</span><textarea autoFocus disabled={viduBusy !== null} spellCheck={false} value={viduJwtText} placeholder="每行一个 JWT" onChange={(event) => setViduJwtText(event.target.value)} /></label>
                <label><span>SSUID（可选）</span><input disabled={viduBusy !== null} spellCheck={false} value={viduSsuid} onChange={(event) => setViduSsuid(event.target.value)} /></label>
              </div>
              {viduJwtResults.length > 0 && (
                <div className="vidu-jwt-results" aria-live="polite">
                  {viduJwtResults.map((result) => (
                    <div className={result.status} key={`${result.lineNumber}:${result.account?.id ?? "failed"}`}>
                      <strong>第 {result.lineNumber} 行</strong>
                      <span>{result.message}</span>
                      {result.account && <span>{result.account.name}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </ModalDialog>

      <div hidden={activeTab !== "folder"}>
        <BackupPanel />
        <LegacyImportPanel />
      </div>
    </div>
  );
}
