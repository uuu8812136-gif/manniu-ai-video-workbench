# AI工具 0.8.6 原版功能对齐审计

审计日期：2026-07-27

## 审计目标

本审计核对 AI工具与原版业务入口、字段、状态变化和工作流意图是否对齐。目标是独立实现可持续维护的本地源码版，不复制原版或客户参考包的代码、远端服务和缺陷。

客户参考包只用于识别功能入口、字段和交互意图。其推理卡死、登录后自动退出、第三方卡密依赖和远端账号分发不进入产品源码，也不作为兼容目标。

## 基线与方法

- 原版隔离证据：`../original-harness/evidence/original-ui-interactions.json`。
- 当前版动态证据：`audit/evidence/current-ui-interactions.json`。
- 严格字段差分：`audit/evidence/original-current-interaction-field-diff.json`。
- 当前动态扩展规格：`audit/current-extra-dynamic-spec-2026-07-27.json`。
- 客户参考包静态映射：`audit/CUSTOMER-PACKAGE-STATIC-GAP-2026-07-27.md`。
- 验证维度：真实 DOM 操作、IPC 参数、SQLite 前后快照、localStorage、文件哈希、网络边界和进程存活。

## 最终结论

- 原版隔离交互：71/71 通过，外网请求 0。
- 当前版统一动态交互：71/71 通过，真实 UI 操作 71，IPC/SQLite 证据 71，失败 0。
- 当前动态证据 SHA-256：`10F55CE20FA2E31F70F0EA9B355A740A1CCB747B3BD8FA64E1E81415113C542B`。
- 严格差分：`cases=71`、`currentDynamicPassed=71`、`missingEntryPoints=0`。
- 确认业务差异：`confirmedBusinessDifferences=[]`。
- 专项扩展覆盖：field builder、case note、level policy 均为 `26/26`。
- 用例级分类：9 项 adapted、53 项 enhanced、5 项 equal、1 项 not-applicable、3 项 runtime-not-comparable。
- 字段级分类：151 项 adapted、70 项 enhanced、191 项 equal、3 项 runtime-not-comparable，没有 `different` 字段。

这表示原版已确认功能入口均有当前版自研实现或明确的有意排除，没有发现未说明的业务缺口。`enhanced` 表示当前版增加了 SQLite 持久化、真实文件证据、错误终态、取消/恢复或更精确目录行为，不表示复制原版实现。

## 关键适配

- 原作者应用登录门禁被移除；启动和业务路由不依赖 token、用户信息或设备 ID。
- 当前版没有应用账号会话，因此不提供会重新引入门禁的假“退出登录”入口。
- 原作者在线更新器改为本地覆盖安装说明，不连接原作者更新服务。
- 任务暂停、取消和恢复进入持久化队列，避免只改前端状态。
- DOCX/TXT 文件标题可从文件名正确回填，修复原版 fallback 使文件名回填不可达的问题。
- 图片重发新增独立 SQLite job，不覆盖历史结果；打开目录优先进入已完成批次目录。
- Vidu 主体库能力按用户自己的隔离 Vidu 会话重新实现，不调用参考包卡密或凭证服务。
- 删除 Vidu 账号只清理目标账号 session；普通检查、轮询和主体读取不会清 session。

## 已知缺陷反向验证

- 推理成功落为 `done`，不可恢复失败落为 `error`，取消落为 `cancelled`，可恢复中断落为 `paused`。
- 文件 Agent 不设置固定静默超时；长任务不会因中间无日志被误杀，用户主动停止和真实错误终态仍保留。
- 原版前端没有传入推理 timeout 参数，也没有 120 秒前端静默计时器；随包代理注释指向后端 `STALL_SECS(600s)`。因此 0.8.5 的 120 秒默认值属于当前版差异，已在 0.8.6 删除。
- 应用不存在原作者登录会话和自动退出链路；Vidu 单账号异常不会关闭应用或清理其他账号。
- 暂停场景在完整动态审计通过，并连续稳定性复跑 3/3 通过。
- 强制终止打包程序后，运行任务可恢复为 `queued`，恢复事件不重复，SQLite 完整性正常。

## 客户参考包映射

客户参考包静态映射共 14 项：3 项 covered、7 项 enhanced、4 项 intentionally not applicable、0 项 real gap。该映射只说明功能入口和意图已覆盖或有意排除，不表示复用了客户参考包实现。

## 角色推理

原版角色推理词来自文件 Agent 的角色表和分镜工作流，不是孤立前端字段。当前版实现角色表、ABC 骨架、分批 D 列、B/D 硬校验、越权回滚、结构化修复和独立语义审片，并在项目详情展示人物、场景、特殊空间和完整推理词。

结构、字段和状态机通过不代表不同模型的文案会逐字一致。角色推理主观质量仍需使用相同输入、相同模型、相同参数和相同参考资料做 A/B 验收。

## 不可比与外部验收

以下 3 项保留为 `runtime-not-comparable`：

- `project-check`：原版使用确定性 Vidu mock，当前隔离审计没有匹配的真实网站 task。
- `polish-submit`：隔离审计主动阻断第三方文本模型请求。
- `image-submit`：隔离审计主动阻断第三方图片模型请求。

最终打包版已使用克隆 userData 完成 Vidu 非付费只读验收：登录、积分和主体分页均成功，错误 0；没有提交视频或修改远端主体。

仍需客户环境验收：真实付费视频提交、轮询、下载和首页回显；客户模型角色推理 A/B；目标剪映版本真实导入；干净 Windows 机器、SmartScreen 和杀毒软件。
