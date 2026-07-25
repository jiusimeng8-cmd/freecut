# FreeCut 仓库维护与交付清单

更新时间：2026-07-25

## Git 远端与分支

- 产品仓库：`https://github.com/jiusimeng8-cmd/freecut.git`
- 上游仓库：`https://github.com/walterlow/freecut.git`
- 当前开发分支：`codex/dev-workspace-bridge`
- `origin/main` 跟随上游稳定基线；产品改动先进入功能分支，通过检查后再合并。
- 不把本地凭据、项目素材、Electron userData、运行日志、安装包或解包目录提交到 Git。

## 目录归属

| 路径 | 归属 | Git 策略 |
| --- | --- | --- |
| `src/` | Renderer、编辑器、MCP 工具、Web 运行时 | 提交 |
| `desktop/` | Electron Main、Preload、IPC、本地 Agent Host、Bridge | 提交 |
| `scripts/` | 开发、构建、打包、发布与验收脚本 | 提交 |
| `docs/` | 产品架构、交接、错误报告 | 提交 |
| `docs/local-e2e/*.json` | 含本机绝对路径的机器验收输入 | 本地保留，不提交 |
| `resources/licenses/` | 产品第三方许可声明 | 提交 |
| `resources/windows/ffmpeg/` | 本机 FFmpeg 打包资源 | 本地生成，不提交 |
| `dist/`、`dist-electron/` | Renderer 与 Electron 编译产物 | 本地生成，不提交 |
| `release/`、`release-*/` | 安装包、解包目录、QA 运行状态 | 本地归档，不提交 |
| `tmp/`、`logs/`、`*.log` | 测试临时目录与日志 | 本地保留，不提交 |
| `.env.local`、`.env.*.local` | 本地地址与配置 | 本地保留，不提交 |
| `<userData>/private/` | safeStorage、Agent Thread、Bridge 凭据 | 仅运行时保留，禁止复制到仓库 |

## 本地构建资产

Windows 打包前先准备 FFmpeg：

```powershell
npm run desktop:prepare-resources
```

脚本从 `FREECUT_FFMPEG_PATH`、`FREECUT_FFPROBE_PATH` 或系统 `PATH` 读取
本机可执行文件，并生成 `resources/windows/ffmpeg/manifest.json`。这些文件体积大，
且属于可再生成的本机资产，因此不进入 Git。

常用命令：

```powershell
npm run dev
npm run desktop:dev
npm run desktop:check
npm run desktop:test
npm run desktop:build
npm run desktop:pack
```

`npm run desktop:dev` 默认工作区仅用于开发。涉及真实项目时必须显式确认
`FREECUT_DEV_WORKSPACE`；自动化和验收应使用隔离 workspace、userData 与端口。

## 提交前检查

1. `git status --short` 中不得出现 `release*`、`dist-electron`、FFmpeg 可执行文件、
   userData、Cookies、Trust Tokens、`bridge.json` 或真实凭据文件。
2. 检查 `.env.example` 只包含占位符和配置说明。
3. 运行 `npm run desktop:check` 和 `npm run desktop:test`。
4. 运行 `npm run desktop:build`，确认 Renderer、Main、Preload 均可构建。
5. 重大 Renderer 改动再运行 `npm run check` 和相关测试。
6. 提交到功能分支并推送 `origin`，不要直接推送 `upstream`。

## Agent 产品边界

- Web 开发端可以运行编辑器，但没有 Electron Main/Preload，因此不能启动本地 Agent Host。
- Agent 的 Thread、Run、Event、Checkpoint 与 ToolReceipt 只存储在
  `<userData>\private\agent-runtime`。
- API Key 只经 Electron safeStorage 保存，不写 Renderer 状态、日志或 Git。
- 写工具必须经过本地审批、lease、fencing、幂等执行和 readback。
- 模型与 Provider 由 Profile 和能力路由决定，不在 Renderer 或 MCP 合同中写死。

## 文档入口

- 产品执行计划：`docs/agent-platform-execution.md`
- 项目交接表：`docs/agent-platform-handover.md`
- 云端方向：`docs/cloud-ai-editor-direction.zh-CN.md`
- 已知问题记录：`docs/error-reports/`
- 联合验收输入：`docs/local-e2e/`（本地生成，不进入 Git）

## 本地归档

历史 `release*` 目录应统一移出仓库，保留在同盘本地归档中。归档只用于追溯安装包
和 QA 环境，不作为源码事实源，也不应上传 GitHub。需要新的安装包时应从当前提交
重新构建。
