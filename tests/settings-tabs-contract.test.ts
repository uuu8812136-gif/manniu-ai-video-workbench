import { describe, expect, it } from "vitest";
import { parseAppRoute, type SettingsSection } from "../src/renderer/src/lib/app-route";
import { settingsTabs } from "../src/renderer/src/pages/settings-tabs";

const expectedTabs: Array<{ key: SettingsSection; label: string }> = [
  { key: "browsers", label: "浏览器账号" },
  { key: "folder", label: "项目文件夹" },
  { key: "novel-optimizer", label: "开头优化" },
  { key: "text-polish", label: "捋文设置" },
  { key: "inference", label: "推理设置" },
  { key: "imagegen", label: "出图设置" },
  { key: "jianying", label: "剪映路径" },
  { key: "notifications", label: "通知设置" },
];

describe("original settings tab contract", () => {
  it("keeps the original eight tabs in their original order", () => {
    expect(settingsTabs).toEqual(expectedTabs);
  });

  it("opens every tab through the original tab query parameter", () => {
    for (const tab of expectedTabs) {
      expect(parseAppRoute({ hash: `#/settings?tab=${tab.key}`, pathname: "/" })).toEqual({
        view: "settings",
        settingsSection: tab.key,
      });
    }
  });
});
