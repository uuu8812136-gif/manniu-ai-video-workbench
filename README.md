# 漫牛 AI 视频创作工作台

当前交付版本：`0.8.22`

漫牛是 Windows x64 本地优先的 AI 视频创作工作台，采用 Electron + React + TypeScript 构建，项目、分镜、队列、日志和设置保存在本地 SQLite 中。它把小说/文本处理、分镜校验、图片/视频生成、批量任务和剪映草稿导出收敛到同一套桌面工作流，属于可运行的企业私有项目交付，不是在线网站。

本仓库是供招聘和技术审阅使用的源码快照，已排除 `node_modules`、构建目录、Junction、历史运行审计数据、SQLite 数据库、日志、安装包和用户项目资产；仓库不包含真实 API Key、JWT、Cookie 或模型密钥。原始 Windows 桌面交付所需的 `vendor/` 运行时目录（包含 FFmpeg、Python、Claude 文件 Agent 及其配套资源）因含大体积二进制文件而不纳入 GitHub 源码仓库，完整运行时随私有交付包单独保留；因此仅克隆本仓库不能直接执行 `package:all`，需要先按交付环境补齐 `vendor/`。

## 环境要求

- Windows 10/11 x64
- Node.js 22 或更新的 LTS 版本
- pnpm 10
- 桌面交付包内置：Windows x64 FFmpeg / FFprobe 运行时，用于媒体诊断和处理
- 桌面交付包内置：Windows x64 最小 Python 运行时和原版兼容推理校验规则
- 桌面交付包内置：固定 Windows x64 Claude 文件 Agent 运行器和本地 OpenAI Chat 协议代理
- 可选：剪映客户端，用于实际打开导出的草稿

## 已完成模块

- **项目与分镜**：项目目录、角色表、分镜表、图片/视频资产、批次任务、状态回写和本地日志。
- **文本工作流**：小说导入、角色与 ABC 骨架、分批生成 D 列、结构化修复、独立语义审片和硬校验。
- **媒体工作流**：OpenAI Images / Gemini 图片生成，自定义异步视频 API，格式/大小校验，原子落盘和任务回写。
- **Vidu 浏览器账号模式**：独立 Electron 会话、多账号池、JWT 批量导入、指纹去重、过期检查、额度显示、限频切号、任务找回、断点恢复、退避重试和不确定提交防重复。
- **本地数据与交付**：SQLite 事务、项目目录备份/恢复、SHA-256 清单、完整性检查、失败回滚、Electron `safeStorage` 加密和桌面交付包内置的 Windows x64 FFmpeg/FFprobe。
- **剪映导出**：导出草稿、素材映射、字幕/音频和时间轴重排；生成文件可交给目标剪映版本继续验收。

## 从源码运行

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm dev
```

开发服务默认由 `electron-vite` 启动。开发网页预览中的示例数据只在 `import.meta.env.DEV` 下安装，不会进入生产运行路径。

## Windows 打包

```powershell
pnpm package:all
```

输出位于 `dist`：

- `ai-tool-setup-<version>-x64.exe`：NSIS 安装包
- `ai-tool-portable-<version>-x64.exe`：便携版
- `ai-tool-source-<version>.zip`：可独立安装依赖、测试和构建的源码包
- `win-unpacked`：解包运行目录
- `SHA256SUMS.txt`：交付文件校验值

打包命令会依次执行类型检查、生产构建、ASAR 与随包资源边界审计、解包/安装版/便携版启动烟测、源码白名单与凭证预检，最后统一生成 SHA-256。

## 数据位置

- 安装版：Electron 的 `%APPDATA%\ai-tool` 用户数据目录
- 便携版：便携 EXE 同级的 `ai-tool-data`

主要内容包括：

- `ai-tool.db`：SQLite 数据库
- `projects`：项目图片、视频和其他资产
- `logs`：本地日志目录

设置页可创建完整目录备份并校验清单、文件大小、SHA-256 和 SQLite 完整性，也可在应用重启时一键恢复。恢复使用同卷暂存、哈希复验、原子替换和失败回滚；项目根目录内的绝对路径会随新数据目录改写。API Key 由 Electron `safeStorage` 加密；Windows 下使用当前用户/计算机的 DPAPI 作用域，跨 DPAPI 作用域恢复时会清空无法解密的密钥并提示重新填写。

## 模型 API

### 文本

文本润色及非原版兼容文本模式支持：

- OpenAI Responses API
- OpenAI Chat Completions API

小说转分镜和原版 `general/enhanced` 开头使用文件 Agent，要求模型地址提供 `/v1/chat/completions`；协议固定为 Chat Completions，`thinking=disabled`，单轮 `max_tokens=64000`。设置页配置 API 地址、模型、主 Key、备用 Keys 和每 Key 并发数。API 地址可以是公网、局域网或 `127.0.0.1` 上的兼容网关。

小说推理由不同的 Claude 文件 Agent 会话依次完成角色表与 ABC 骨架、10/20/30 镜 D 列批次、结构化定向修复和独立语义审片；Python 在每阶段执行 B 列、角色表和 D 列硬校验，并恢复 Agent 越权修改的 ABC、角色表或批次外 D 列。失败会保留 `.ai-tool-inference/<jobId>` 目录和诊断报告。

### 图片

支持：

- OpenAI Images API
- Gemini 原生 `generateContent` 图片响应

项目内生图会在格式和大小校验后原子写入项目目录，并回写对应分镜。独立生图工作台使用单独任务和批次目录，不要求选择项目，也不会创建、覆盖或改写已有项目分镜。

### 视频

视频生成支持两种模式。

#### 自定义 API

通用异步视频适配器按以下流程工作：

1. `POST` 提交路径，响应包含 `task_id`、`taskId` 或 `id`。
2. 按设置的 `GET`/`POST` 状态路径轮询；路径可用 `{taskId}` 占位符。
3. 成功响应包含常见的 `result_url`、`video_url` 或嵌套 `url` 字段。
4. 客户端流式下载视频，校验大小和格式后原子落盘。

具体供应商字段不同于上述兼容格式时，应在 `src/main/video-client.ts` 增加供应商适配。

#### Vidu 浏览器账号

1. 在设置页的“Vidu 浏览器”中添加账号，打开独立窗口并自行登录。
2. 登录检测只读取 Vidu 任务历史；检测本身不会提交生成任务或消耗积分。
3. 选择 Vidu 模式后，可使用 Q2/Q3、积分或错峰模式提交 `character2video` 任务；Q3 前置数量支持前 N 镜使用 Q3、后续切换 Q2，`N=0` 表示全程 Q3。
4. 分镜的资产图会按账号和项目上传、缓存，并根据分镜 `subjects` 自动绑定主体。
5. 程序持久化账号、供应商 task ID 和提交状态，轮询完成后下载并校验视频，再与 Job 完成状态写入同一 SQLite 事务。
6. 支持积分账号 JWT 逐行批量导入、重复指纹拦截、登录验证，以及主体限频自动禁用/切号。
7. 在途任务达到 100 或普通 `429` 时暂停新提交，每 5 秒探测一次，容量恢复后继续；等待期间可停止任务。
8. 支持按账号分页复制全部自建主体、粘贴到另一个已登录账号，以及经双重确认后清空主体库；本地主体剪贴板不保存 JWT、Cookie 或 API Key。

任务在提交阶段遇到无法判定的网络或进程中断时会进入 `uncertain` 状态，程序不会自动重发。必须在界面绑定网站 task ID，或明确清除不确定状态后才能继续，从而避免重复提交和重复扣积分。批量生成只处理缺失视频；已有视频的重新生成需要用户确认。账号池显示总额度、已用、剩余和禁用原因，生成期间会锁定编辑。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm package:audit
```

`tests/local-api-e2e.test.ts` 使用真实的 `127.0.0.1` HTTP 服务覆盖兼容推理、图片生成、视频提交/轮询/下载、同一 SQLite 项目回写和真实文件落盘。`tests/original-agent-real.test.ts` 可通过 `RUN_REAL_CLAUDE_AGENT=1` 启用，使用随包 `claude.exe` 和本地协议服务验证真实 `Write/Edit/Bash` 文件工具循环。

本轮源码复核结果：`pnpm typecheck` 通过；`pnpm test` 共执行 562 项，其中 557 项通过、2 项跳过，`tests/package-source-contract.test.ts` 的 3 项失败均发生在测试通过 `powershell.exe` 子进程调用 `Get-FileHash` 时的当前机器命令环境，不是 TypeScript 编译错误。历史交付记录中的构建、打包审计和 Windows 烟测结果保留在版本报告中，不能替代本轮测试结果。

Vidu 相关测试覆盖请求协议、历史任务匹配、账号会话隔离、主体素材缓存、任务状态恢复、21 分钟恢复租约、5/15/60 分钟退避、删除保护、重复提交保护和视频下载校验。真实 Vidu 账号的登录检查需要在应用的独立 Vidu 窗口中完成；真实生成任务会消耗账号积分，不属于默认自动测试。

## 已知交付边界

- 模型生成仍取决于所配置 API 的协议兼容性、额度和可用性；纯本地数据功能不依赖模型服务。
- Vidu 浏览器模式依赖 Vidu 当前网页接口、账号状态、额度和网络可用性。Codex 内置浏览器、系统浏览器与 AI工具的 Vidu 会话互不共享，需要在 AI工具窗口中单独登录。
- Windows x64 安装版和便携版均内置 FFmpeg / FFprobe；设置页仍可选择自定义可执行文件覆盖默认运行时。
- 剪映草稿结构已做程序校验；原版可用证据不含导出后端源码或真实草稿样本，仍需按目标剪映版本做一次客户端导入验收并保存兼容基线样本。
- 当前 Windows EXE 未做代码签名，可能触发 SmartScreen 或杀毒软件提示。
- 发布前应在干净 Windows 机器验证安装、快捷方式、升级和卸载。

## 交付状态

- 源码版本：`0.8.22`；本轮类型检查通过，自动测试结果见“验证”章节；历史版本报告记录了生产构建、ASAR 审计和 Windows 安装/启动/SQLite 烟测证据。
- 默认测试不提交真实 Vidu 视频任务，不消耗客户积分；真实账号登录、付费视频生成和目标剪映版本导入仍由客户在自己的环境中验收。
- 历史 `AI工具交付与验收报告-*.md`、`ORIGINAL-PARITY-AUDIT-*.md` 和 `UI-PARITY-MATRIX-*.md` 用于记录开发过程，不代表每一项都是本次重新执行的测试。
