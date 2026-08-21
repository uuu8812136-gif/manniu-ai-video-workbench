# AI工具交付与验收报告 0.8.6

报告日期：2026-07-27

## 交付结论

`AI工具 0.8.6` 的源码、安装版、便携版及自动验收已经完成。当前产品是 Electron、React、TypeScript、SQLite 和本地任务队列组成的独立源码实现，不依赖原作者登录门禁、设备绑定、心跳、遥测或更新服务器。

客户参考包仅用于核对功能入口、字段和交互意图，不复制其代码、远端服务协议或实现细节，也不继承其推理卡死、登录后自动退出等已知缺陷。产品对外名称仅为 **AI工具**。

自动验收结论不是第三方真实环境的无限保证。真实付费视频提交、客户模型生成质量、目标剪映版本和干净 Windows 机器兼容性仍列在本报告的外部验收项中。

## 自动验收结果

### 0.8.6 推理超时修复

- 原版前端 `run_novel_inference` 没有传入 timeout 参数，推理页也没有 120 秒前端计时器。
- 原版随包代理注释指向后端 `STALL_SECS(600s)`；当前版先前的固定 120 秒属于自研实现差异，不是已验证的原版行为。
- 0.8.6 已删除文件 Agent 固定静默超时。长任务只会因用户主动停止、子进程真实退出或模型/API 明确错误而结束。
- 回归测试把无输出 Agent 静默推进 24 小时，进程树未被终止；随后用户停止仍能正确清理 Claude 与代理进程树。

### 源码与动态交互

- `pnpm typecheck`：通过。
- `pnpm test -- --reporter=dot`：74 个测试文件通过，481 项测试通过，2 项按条件跳过，0 项失败。
- `pnpm build`：main、preload、renderer 生产构建通过。
- 当前版统一动态审计：71/71 通过，真实 UI 操作 71，IPC/SQLite 证据 71，失败 0。
- 动态证据：`audit/evidence/current-ui-interactions.json`。
- 动态证据 SHA-256：`10F55CE20FA2E31F70F0EA9B355A740A1CCB747B3BD8FA64E1E81415113C542B`。
- 严格原版差分：`cases=71`、`currentDynamicPassed=71`、`missingEntryPoints=0`、`confirmedBusinessDifferences=[]`。
- 扩展严格覆盖：`26/26/26`，分别为专项 field builder、case note 和 level policy。
- `project-check`、`polish-submit`、`image-submit` 保留为 `runtime-not-comparable`：隔离审计主动阻断外网，未把第三方真实结果伪装成通过。

### 已知缺陷反向回归

- 推理成功必须落为 `done`，不可恢复失败必须落为 `error`，取消落为 `cancelled`，可恢复中断落为 `paused`；不得长期残留 `queued/running`。
- 文件 Agent 已取消固定静默超时；24 小时静默回归中任务保持运行，用户主动停止仍会终止并清理进程树。
- 应用没有原作者账号会话和“退出登录”门禁，业务路由可直接访问，不会发生应用登录后一会自动退出。
- Vidu 普通登录页、状态检查、轮询和主体读取不清理 session；删除账号只清理目标账号的隔离 session。
- 暂停按钮等待真实可用状态后执行，连续稳定性复跑 3/3 通过。

### 最终包验证

- `pnpm package:all`：通过。
- 生产资源审计：`originalServiceMarkers=0`，内置 Claude、Python、推理/开头规则及 FFmpeg/FFprobe 资源完整。
- 解包版启动/SQLite 建库烟测：通过。
- 断网启动、本地 CRUD、FFmpeg/FFprobe 健康检查：通过，未修改系统防火墙规则。
- 强制结束恢复：运行中 9 个任务，重启后目标任务恢复为 `queued`，仅记录 1 条恢复事件，`SQLite quick_check=ok`。
- 便携版：启动器同级 `ai-tool-data` 建库通过。
- 安装版：静默安装、启动建库、卸载通过。
- 开发构建 UI 巡检：35 个页面/交互快照，0 失败，0 外网请求。
- 打包版 UI 巡检：35 个页面/交互快照，0 失败，0 外网请求。
- 最终打包版 Vidu 非付费只读验收：1 个配置账号，1 个登录有效，1 个返回积分，主体分页 1/1 完整，错误 0，主体数 0。
- Vidu 只读验收没有提交视频、创建/粘贴/删除主体，也没有读取或输出 JWT/Cookie。

## 交付文件

客户交付目录包含：

- `ai-tool-setup-0.8.6-x64.exe`
- `ai-tool-portable-0.8.6-x64.exe`
- `ai-tool-source-0.8.6.zip`
- `SOURCE-MANIFEST-0.8.6.sha256`
- `SHA256SUMS.txt`
- `AI工具交付与验收报告-0.8.6.md`
- `ORIGINAL-PARITY-AUDIT-0.8.6.md`
- `current-ui-interactions.json`
- `original-current-interaction-field-diff.json`
- `UI-PARITY-AUDIT-0.8.6.json`
- `UI-PARITY-AUDIT-0.8.6-development.json`
- `live-vidu-readonly-packaged-0.8.5-2026-07-27.json`

安装包、便携版和源码 ZIP 的最终 SHA-256：

- `ai-tool-setup-0.8.6-x64.exe`：`A30A98994727E5E3DC340551C361E41FA9E5EB1792C3A00ED5F5ECE53F6D898F`
- `ai-tool-portable-0.8.6-x64.exe`：`BE5A09D6B1D823550F34DA265B95A458FBD88E005F6CE3A3FA13638A6E52CAF8`
- `ai-tool-source-0.8.6.zip`：源码报告写入后重新生成，最终值以交付目录中的 `SHA256SUMS.txt` 为准。

## 外部验收项

- [ ] 使用客户实际模型、相同输入、相同模型和相同参数进行原版/新版角色推理质量 A/B。
- [ ] 使用客户自己的 Vidu 账号执行真实视频提交、轮询、下载和首页回显；该操作可能消耗积分。
- [ ] 在客户目标剪映版本导入真实草稿，检查素材、字幕、音频和时间线。
- [ ] 在干净 Windows 10/11 x64 机器验证交互式安装、覆盖升级、快捷方式、重启和卸载。
- [ ] 验证目标机器上的 SmartScreen、杀毒软件和未签名程序提示。

## 凭证与数据

- 源码、报告和交付包不包含真实模型密钥、JWT、Cookie、私钥或客户数据库。
- 模型密钥由用户在本机设置页填写，并使用 Electron `safeStorage` 加密。
- Vidu 登录状态保存在账号隔离会话中，不与 Codex 内置浏览器或系统浏览器共享。
- 安装版与便携版使用不同的数据目录语义；迁移到其他 Windows 用户或电脑后可能需要重新填写模型配置并重新登录。
