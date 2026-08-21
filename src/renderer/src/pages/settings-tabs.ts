import type { SettingsSection } from "../lib/app-route";

export const settingsTabs: ReadonlyArray<{ key: SettingsSection; label: string }> = [
  { key: "browsers", label: "浏览器账号" },
  { key: "folder", label: "项目文件夹" },
  { key: "novel-optimizer", label: "开头优化" },
  { key: "text-polish", label: "捋文设置" },
  { key: "inference", label: "推理设置" },
  { key: "imagegen", label: "出图设置" },
  { key: "jianying", label: "剪映路径" },
  { key: "notifications", label: "通知设置" },
];
