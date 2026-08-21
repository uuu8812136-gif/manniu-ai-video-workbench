# Windows 打包与验收边界

当前交付版本：`0.8.22`

## 环境要求

- Windows 10/11 x64
- Node.js 22.12 或更高版本
- pnpm 10
- 首次构建可访问 Electron 与 electron-builder 镜像

使用 `pnpm install --frozen-lockfile` 安装锁定版本的依赖。

## 构建命令

- `pnpm package:dir`：生成 `dist/win-unpacked`，审计 `app.asar`，并以隔离数据目录启动打包后的应用做烟测。
- `pnpm package:nsis`：生成当前用户安装的 NSIS 安装包，并写入 `dist/SHA256SUMS.txt`。
- `pnpm package:portable`：生成 portable 可执行文件，直接启动 portable 包副本验证数据目录，并写入校验和。
- `pnpm package:source`：按源码白名单生成确定性 ZIP，并在打包前拦截凭证、私钥、数据库和临时文件。
- `pnpm package:all`：构建并验证安装版、便携版和源码 ZIP，最后统一写入校验和。

所有命令都从锁定的源码和依赖重新编译，且显式禁用发布。Windows x64 交付物会复制固定 Claude 文件 Agent、OpenAI Chat 协议代理、最小 Python 校验运行时以及 `vendor/ffmpeg/win-x64` 的 FFmpeg、FFprobe、运行所需 DLL 和许可证文件。

## 数据目录

NSIS 安装版使用 Electron 的当前用户 `userData` 目录。覆盖升级会复用该目录，卸载程序不会删除项目、设置、日志或 SQLite 数据库。

Portable 版把数据保存在启动器同级的 `ai-tool-data`。移动 portable 版时应同时移动该目录。API Key 由 Electron `safeStorage` 加密；Windows 下实际使用当前用户的 DPAPI 上下文，因此把数据复制到其他 Windows 账号或电脑后，需要重新填写 API Key。

## 自动验证范围

打包审计会验证主进程、preload、renderer、固定 Claude 文件 Agent、协议代理、最小 Python、Windows x64 的 `better-sqlite3` 原生模块和完整 FFmpeg 运行时，排除源码、测试、构建脚本、source map 和其他平台的 SQLite 模块，并检查生产代码中不存在已知原厂登录与上报端点。

烟测会实际启动 `win-unpacked`、静默安装后的应用和 portable 包，使用隔离目录并等待有效 SQLite 文件头出现；安装版还会执行静默卸载。断网烟测通过真实 preload IPC 调用 `media.health({ ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" })`，确认内置运行时无需系统安装即可使用；结束时只终止烟测启动的进程树。

## 仍需人工验收

当前仓库不保存代码签名证书，未通过 `CSC_LINK` 等安全构建变量提供证书时，生成的 EXE 为未签名状态，Windows SmartScreen 可能提示未知发布者。当前也未配置产品图标，electron-builder 会使用默认 Electron 图标。

自动检查不能替代干净 Windows 机器上的安装、快捷方式、覆盖升级、卸载、杀毒软件、代码签名和重启验收。在这些步骤完成前，不应声称安装验收已经通过。
