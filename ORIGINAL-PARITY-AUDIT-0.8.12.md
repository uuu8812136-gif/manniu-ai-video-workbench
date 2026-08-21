# 原版对齐审计 0.8.12

## 已对齐

- 项目详情采用中央分镜工作区和 316px 独立滚动右栏。
- 分镜为无表头卡片行，原文、时长和画面提示词静态展示，点击弹窗编辑。
- 保留批量修改、一键检查、生成所选、剪映导出、自动剪辑、Q2/Q3、开始/暂停/继续/停止、清空重来。
- 概览恢复已发送次数、完成百分比、成功/进行/失败/总数统计。
- 分镜媒体离开视口后卸载，并使用 `content-visibility` 跳过屏外布局和绘制。
- 右栏与主栏均为独立滚动；166 条运行时截图已验证。

## 有意修正原版误导

- 原版“全局账号额度”实际是本地配额统计，不是网站实时积分。当前改为“本地账号任务额度”，并通过 title 明确网站积分需在设置页检查。
- 批量任务异步失败后会撤掉“已加入”绿色提示，并在概览显示聚合失败原因。
- 所有依赖系统 `prompt` 的操作改为应用内弹窗，避免 Electron 中点击无反应。

## 证据

- `audit/evidence/large-project-166.json`
- `audit/evidence/large-project-166.png`
- `audit/evidence/project-ui-parity.json`
- `audit/evidence/uncertain-clear-delete-0.8.12.json`
- `dist/UI-PARITY-AUDIT-0.8.12.json`
