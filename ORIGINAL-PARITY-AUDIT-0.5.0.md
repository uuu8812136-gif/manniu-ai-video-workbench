# AI工具 0.5.0 原版业务功能复审

复审日期：2026-07-27

## 基线

- 原版：`E:\漫牛自动化\manniu-animation.exe`
- 原版版本：`3.5.0`
- 原版 SHA-256：`A9408A52B93E1729E24802E7D365C6469AFD035B993116136F43174595EB20A1`
- 原版前端证据：`../original-assets/*.pretty.js`
- 原版运行时证据：`../original-runtime-3.5.0-live`
- 当前源码：本目录，版本 `0.5.0`

当前程序是独立的 Electron + React + TypeScript 源码实现，不是原作者源码泄露或逐文件复制。复审目标是原版业务行为与交付产物兼容，不恢复原作者品牌、登录授权、设备绑定、遥测或原作者更新服务器。

## 结论

- 角色推理差异项已补齐并通过专项测试。
- 开头、捋文、推理、生图、项目、批量队列、Vidu、剪映和设置的原版可见业务入口均有当前实现。
- 本轮直接导入并受控执行原版 Vidu Python，发现的主体节奏、恢复公平性和错误分类差异均已修复；排除明确不恢复的原作者服务后，未再发现缺失的静态确定性原版业务入口。
- 自动化测试不能证明模型文风逐字相同，也不能替代真实 Vidu、真实剪映和干净 Windows 机器验收。

## 本轮补齐

| 模块 | 补齐内容 | 当前证据 |
|---|---|---|
| 角色推理 | 补载 quick lookup、情绪语气、特效触发和角色表模板；完整分句规则；玄幻题材门控 | `src/main/original-inference.ts:403` |
| 角色推理 | D 列加入前后三镜、已完成 D 列和物理场景；10/20/30 批次与失败缩回 10 | `src/main/original-inference.ts:667`、`tests/original-inference.test.ts:233` |
| 角色推理 | 角色表失败回资产修复最多三次；语义 API/JSON 失败降级；逐镜 patch 校验和回退 | `src/main/original-inference.ts:569`、`src/main/original-inference.ts:762` |
| 角色展示 | 保留外观、发型、服装、气质和完整推理词；详情展示人物、场景、特殊空间 | `src/main/original-inference.ts:106`、`src/renderer/src/pages/ProjectDetailPage.tsx` |
| 开头优化 | 原版通用/增强技能、规则库、案例库和文案表；候选数量、编号、题材、过渡句和正文锚点硬校验 | `src/main/opening-runtime.ts`、`tests/opening-runtime.test.ts` |
| 捋文 | 接入原版完整捋文提示词与优先级、自检规则；原版模式和结果字数显示 | `src/main/original-polish-prompt.ts`、`src/main/workflow-prompts.ts` |
| 模型 API | Responses/Chat、SSE 完成门禁、截断保护、`thinking=disabled` 兼容、参考图 | `src/main/model-clients.ts`、`src/main/workflow-handlers.ts:160`、`src/main/image-workflow.ts:113` |
| 项目重置 | 只清状态、媒体绑定和任务记录，不删除磁盘图片或视频 | `src/main/project-reset.ts:5`、`src/renderer/src/pages/ProjectDetailPage.tsx:646` |
| 路由恢复 | hash 路由、前进后退、刷新按 projectId 恢复、工作流设置快捷入口 | `src/renderer/src/App.tsx:42`、`src/renderer/src/lib/app-route.ts` |
| 桌面生命周期 | 单实例；二次启动聚焦；有活动任务时退出确认 | `src/main/index.ts:40`、`src/main/app-lifecycle.ts` |
| Vidu 账号 | 生成期间账号操作锁；JWT 逐行导入、去重、脱敏和结构化登录校验 | `src/main/ipc.ts:200`、`src/main/vidu-jwt.ts`、`src/main/vidu-browser.ts` |
| Vidu 主体 | SHA-1 内容指纹、主体准备三次重试、审核错误 10/20 秒冷却、主体间 3 秒/每 3 个后 10 秒冷却、主体库覆盖优先级、`ElementOperateLimitExceeded` 分类 | `src/main/vidu-browser.ts`、`tests/vidu-browser.test.ts` |
| Vidu 提交 | Q2/Q3 payload 与原版受控执行结果一致；积分预检非 401 放行、并发计数临时失败按原版继续提交、普通提交 403 明确失败、原版额度码全集、429 有限重试、300 秒看门狗 | `src/main/vidu-protocol.ts`、`src/main/vidu-browser.ts`、`tests/vidu-browser.test.ts` |
| Vidu 恢复 | 5 秒扫描、45 秒最小年龄、每批 200 且跨项目轮询、21 分钟原子租约、not_found 5/15/60 分钟退避、最多跨 60 账号找回 | `src/main/video-recovery.ts`、`src/main/repositories.ts`、`tests/vidu-repositories.test.ts` |
| Vidu 下载 | 三次下载、2/4 秒退避、Content-Length、1024B 下限、临时文件清理、原版目录命名 | `src/main/vidu-browser.ts`、`src/main/video-workflow.ts:293` |
| 剪映 | 原版前端普通/SRT 自动剪辑入口和参数已覆盖；当前草稿含素材校验、原子覆盖与失败回滚 | `original-assets/ProjectDetail-BCONVAo4.pretty.js`、`src/main/jianying.ts`、`tests/jianying.test.ts` |

## Vidu/剪映受控差分边界

- 已用 stub Playwright/request 直接导入执行 `original-runtime-3.5.0-live/vidu_automation.py`；Q3/nopeak 的 payload、主体顺序、`[@角色]` 锚点、画质后缀和设置字段与当前实现一致，过程中没有真实网络提交。
- 已直接执行 `vidu_recover.py` 和 `vidu_recovery_worker.py` 的纯函数；终态映射、`not_found` 5/15/60 分钟退避和 `videos/browser_N/<分镜号>.mp4` 命名与当前实现一致。
- 当前对 HTTP 200 的歧义嵌套 `id` 要求任务历史确认，不直接把素材/creation ID 当 task ID；下载还额外拒绝 HTML 和伪媒体响应。这两项是防重复扣费和坏文件落盘的有意强化，不减少原版业务入口。
- `original-runtime-3.5.0-live` 不包含 `export_jianying_draft` 的 Rust/Python 后端或真实 `draft_content.json` / `draft_meta_info.json` 样本。原版前端只能证明入口和入参，当前自动测试只能证明草稿结构、时间轴和素材引用自洽，不能替代目标剪映客户端导入。

## 自动验证

- `pnpm typecheck`：通过。
- `pnpm test`：58 个测试文件、361 项通过、0 项失败；1 项真实媒体测试按设计跳过。
- `pnpm build`：通过。
- 角色推理专项：7/7 通过。
- 路由、项目重置和桌面生命周期专项：9/9 通过。

## 没有恢复

以下项目依赖原作者身份或服务，不属于本地业务工作流，当前明确不复制：

1. 原作者品牌名称和视觉标识。
2. 原作者登录授权门禁和设备绑定。
3. 向原作者服务器发送项目日志、心跳或遥测。
4. 原作者在线更新服务器。当前使用新版安装包覆盖升级，本地数据保留。

## 仍需真实环境验收

1. 使用同一小说、同一模型、同一参数和 `thinking=disabled` 做原版/新版角色推理 A/B，人工比较覆盖率、稳定定妆词和画面词质量。模型输出有随机性，不以逐字相同作为唯一标准。
2. 用真实 Vidu 主体库满场景验证旧项目角色/未来最远出场角色覆盖，并用至少 4 个连续待上传主体验证 3/10 秒节奏不会触发限频。
3. 用至少两个真实 Vidu 账号验证审核冷却、跨账号任务找回、账号归属修正和多项目恢复公平性。
4. 经用户确认积分消耗后，验证真实提交、生成、下载、项目详情和首页进度回显完整链路。
5. 用客户实际剪映版本打开普通草稿和 SRT 自动剪辑草稿，完整播放视频、旁白和字幕；保存一份真实可打开草稿作为后续逐字段兼容基线。
6. 在另一台干净 Windows 10/11 x64 机器验证安装、便携启动、覆盖升级、卸载、SmartScreen 和杀毒软件表现。

这些条目是外部依赖验收，不是当前静态代码中已知的功能空缺。
