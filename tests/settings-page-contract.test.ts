import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { settingsTabs } from "../src/renderer/src/pages/settings-tabs";

const page = readFileSync(
  join(process.cwd(), "src", "renderer", "src", "pages", "SettingsPage.tsx"),
  "utf8",
);

function sourceBetween(start: string, end: string): string {
  const startIndex = page.indexOf(start);
  const endIndex = page.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return page.slice(startIndex, endIndex);
}

describe("settings page parity contract", () => {
  it("renders one fixed panel for every original tab", () => {
    for (const tab of settingsTabs) {
      expect(page).toContain(`id="settings-panel-${tab.key}"`);
    }
    expect(page).toContain('aria-controls={`settings-panel-${tab.key}`}');
    expect(page.match(/<SettingsSaveAction\b/gu)).toHaveLength(settingsTabs.length);
    expect(page).toContain('event.key === "ArrowRight"');
    expect(page).toContain('event.key === "ArrowLeft"');
  });

  it("keeps the Vidu account pool visible when custom video API is selected", () => {
    expect(page).toContain('{form.video_provider === "custom-api" && (');
    expect(page).not.toContain('{form.video_provider === "custom-api" ? (');
    expect(page).toContain('<strong>浏览器账号池</strong>');
    expect(page).toContain('title="添加浏览器账号"');
    expect(page).toContain("单个添加");
    expect(page).toContain("批量 JWT");
    expect(page).toContain("viduAccountIssueTags(account, status)");
    expect(page).toContain("knownOnlineCount");
    expect(page).toContain("总额度");
    expect(page).toContain("单账号顺序使用");
    expect(page).toContain("多账号并行使用");
    expect(page).toContain('disabled={viduBusy !== null || viduAccounts.length === 0}');
    expect(page).toContain('title="检测登录状态" disabled={viduBusy !== null}');
    expect(page).not.toContain('<div className="vidu-account-create">\n                <label>');
  });

  it("shows complete per-account subject clipboard controls and strong clear confirmation", () => {
    expect(page).toContain("subjectClipboardStatus()");
    expect(page).toContain("查询登录与积分");
    expect(page).toContain("availableCredits");
    expect(page).toContain("copySubjectLibrary(account.id)");
    expect(page).toContain("pasteSubjectLibrary(account.id)");
    expect(page).toContain("clearSubjectLibrary(account.id)");
    expect(page).toContain('<Copy size={16} />');
    expect(page).toContain('<ClipboardPaste size={16} />');
    expect(page).toContain('<Eraser size={16} />');
    expect(page).toContain('requestClearViduSubjectLibrary(account)');
    expect(page).toContain('title="清空账号主体库"');
    expect(page).toContain('viduSubjectClearConfirmation !== viduSubjectClearAccount.name');
    expect(page).toContain('输入完整账号名以确认');
    expect(page).not.toContain("window.prompt(");
    expect(page).toContain("逐项结果");
    expect(page).toContain("item.name}：{item.message");
  });

  it("keeps account deletion clickable when locked and reports the reason inside that account row", () => {
    const accountActions = sourceBetween('<div className="vidu-account-actions">', '</div>\n                      {actionMessage');
    expect(accountActions).toContain('aria-disabled={viduBusy !== null}');
    expect(accountActions).toContain('onClick={() => void deleteViduAccount(account)}');
    expect(accountActions).not.toContain('title="删除账号和本地会话" disabled={accountDestructiveLocked}');
    expect(page).toContain('canEditAccountPool("delete", account.id)');
    expect(page).toContain('className={`vidu-account-action-message');
    expect(page).toContain('删除失败：${message}');
  });

  it("uses row controls for inference keys while preserving the legacy setting keys", () => {
    const inferencePanel = sourceBetween('id="settings-panel-inference"', 'id="settings-panel-browsers"');
    expect(inferencePanel).toContain("inferKeyRows.map");
    expect(inferencePanel).toContain("pasteSettingKeyRows");
    expect(inferencePanel).toContain("removeSettingKeyRow");
    expect(page).toContain("infer_api_key: serialized.primary");
    expect(page).toContain("infer_api_keys: serialized.backups");
  });

  it("shows the fixed file-Agent protocol instead of editable no-op controls", () => {
    const inferencePanel = sourceBetween('id="settings-panel-inference"', 'id="settings-panel-browsers"');
    expect(inferencePanel).toContain('<select value="chat" disabled>');
    expect(inferencePanel).toContain('<select value="disabled" disabled>');
    expect(inferencePanel).toContain('value="64000"');
    expect(inferencePanel).not.toContain('<option value="responses">Responses</option>');
  });

  it("shows the webhook URL as ordinary text", () => {
    const notificationPanel = sourceBetween('id="settings-panel-notifications"', '<ModalDialog');
    expect(notificationPanel).toContain('type="text"');
    expect(notificationPanel).not.toContain('type="password"');
  });

  it("keeps opening output separate from text polish API settings", () => {
    const openingPanel = sourceBetween('id="settings-panel-novel-optimizer"', 'id="settings-panel-text-polish"');
    expect(openingPanel).toContain("复用推理设置");
    expect(openingPanel).toContain("opening_output_dir");
    expect(openingPanel).not.toContain("text_polish_api_base_url");
  });

  it("uses original new-install defaults without preselecting notifications", () => {
    expect(page).toContain('infer_api_base_url: "https://api.deepseek.com"');
    expect(page).toContain('infer_model: "deepseek-v4-pro"');
    expect(page).toContain('text_polish_api_key: "捋文主 Key"');
    expect(page).toContain('text_polish_api_keys: "捋文备用 Keys"');
    expect(page).not.toContain("开头与捋文");
    expect(page).toContain('text_polish_api_base_url: "https://ark.cn-beijing.volces.com/api/v3"');
    expect(page).toContain('text_polish_model: "doubao-seed-2-0-pro-260215"');
    expect(page).toContain('imagegen_api_base_url: "https://www.geeknow.top/v1"');
    expect(page).toContain('imagegen_model: "gpt-image-2"');
    expect(page).toContain('vidu_account_dispatch_mode: "sequential"');
    expect(page).not.toContain("vidu_show_active_browser");
    expect(page).not.toContain("切换顺序账号时打开对应 Vidu 网页");
    expect(page).toContain('<option value="https://www.geeknow.top/v1" />');
    expect(page).toContain('<option value="https://yunwu.ai/v1" />');
    expect(page).toContain('webhook_events: ""');
  });
});
