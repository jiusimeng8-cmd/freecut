# 剪好 Agent 平台交接表

更新时间：2026-07-25

## 产品目标

剪好不是“把一条编辑指令丢到云端再等结果”的工具。目标是一个运行在剪辑器侧栏中的
Codex 式 Agent：

```text
用户消息
  -> Electron Local Agent Host（本地 Thread / Run / 审批 / 工具调度）
  -> 云端模型或 ASR Provider（按当前 Profile 路由）
  -> 本地 MCP 工具执行、受控时间线写入、readback
  -> 侧栏显示阶段、结果与可恢复错误
```

本地负责项目读取、工具、缓存、审批、lease / fencing、单写者与验证。云端负责当前
配置的模型推理、ASR 和必要的多模态分析；模型和 Provider 可以替换，不应写死在
Renderer、MCP 工具或本地历史数据中。

## 当前问题与本轮处理

| 问题 | 根因 | 本轮处理 | 状态 |
| --- | --- | --- | --- |
| 侧栏确认后又弹 Windows 原生确认 | Local Agent 的审批和 Bridge 的写工具确认重复执行 | Local Agent 已确认的内部调用跳过第二次确认；外部 Bridge / MCP 调用仍保留原生确认 | 已修复，待隔离 Electron 人工点击确认 |
| `freecut:local-agent:approve -> STALE_FENCE` | 用户等待审批期间，130 秒 lease 到期；后续用旧 fence 完成 Run | 点击确认前续租；执行上限限制为 lease 内 120 秒；续租失败明确返回 `LOCAL_AGENT_APPROVAL_EXPIRED`，不执行写工具 | 已修复，待隔离 Electron 人工点击确认 |
| “快速 / 专家”切换消失 | 设置页退化为原始 `Agent Profile ID` 文本输入 | 恢复为“工作模式”两按钮；Profile ID 可由 Vite 环境变量配置，不绑定模型 | 已修复，待隔离 Electron 视觉核验 |
| 云端显示“Agent 任务未完成”但无法定位 | 旧云端 CommandPack 路径把模型输出、校验、投递阶段混在一个泛化错误中 | 新产品路径改为 Local Agent Host + 单轮 Agent Turn；错误应按阶段显示并留在本地 Run 事件中 | 架构迁移中，云端联合 E2E 待验收 |

## Git 与本地归档

| 项目 | 位置 |
| --- | --- |
| 产品 GitHub | `https://github.com/jiusimeng8-cmd/freecut.git` |
| 交接分支 | `codex/dev-workspace-bridge` |
| 原始上游 | `https://github.com/walterlow/freecut.git` |
| 本地源码 | `D:\Codex\freecut` |
| 安装包 / QA 归档 | `D:\Codex\freecut-local-archive\20260725\packaging` |
| 归档清单 | `D:\Codex\freecut-local-archive\20260725\packaging\archive-manifest.json` |

Git 中包含 Renderer、Electron、MCP、测试、构建脚本、发布配置、许可声明和交接文档。
Git 中不包含 `.env.local`、Key、Electron userData、日志、`dist*`、`release*`、
FFmpeg 二进制、项目素材或 `docs/local-e2e` 机器证据。云端控制面是下表所列的
独立仓库，不包含在本次 FreeCut Git 提交中。

## 代码与运行资产

| 区域 | 位置 | 怎么找 / 启动 | 说明 |
| --- | --- | --- | --- |
| 桌面与 Renderer 仓库 | `D:\Codex\freecut` | `npm run dev` 启动 Web；`npm run desktop:dev` 启动 Electron | 本交接分支包含一次大范围产品迁移；接手后不要随意 reset、checkout 或格式化全仓 |
| 本地 Agent Host | `D:\Codex\freecut\desktop\agent-runtime\` | Electron Main 启动时创建 | 本地事实源：Thread、Run、Event、Checkpoint、ToolReceipt |
| 本地 Agent IPC / Main | `D:\Codex\freecut\desktop\main.ts` | 搜索 `localAgentHost`、`LOCAL_AGENT_LEASE_TTL_MS` | 注册 IPC、持有 lease、连接 Local Agent Host |
| 本地 Agent 协调 | `D:\Codex\freecut\desktop\services\local-agent-host-service.ts` | 搜索 `approve(` | 审批、续租、Bridge 写入、readback 与完成状态 |
| 本地 Bridge | `D:\Codex\freecut\desktop\bridge\bridge-service.ts` | 搜索 `confirmedByLocalAgent` | 统一调度 MCP / 工具；普通外部写调用仍需要确认 |
| 侧栏 Agent UI | `D:\Codex\freecut\src\features\editor\components\agent-chat-panel.tsx` | 编辑器右侧 Agent 面板 | 显示本地状态、审批、对话 |
| 云端 / MCP 设置 | `D:\Codex\freecut\src\features\editor\components\cloud-agent-settings-popover.tsx` | Agent 面板右上角设置 | 包含 MCP 地址、Key 输入与“快速 / 专家”模式 |
| Profile 配置 | `D:\Codex\freecut\src\features\editor\agent\cloud-agent-config-store.ts` | 搜索 `CLOUD_AGENT_PROFILE_OPTIONS` | `VITE_FREECUT_AGENT_FAST_PROFILE_ID` / `VITE_FREECUT_AGENT_EXPERT_PROFILE_ID` 可覆盖路由 Profile |
| Web 云端地址 | `VITE_FREECUT_CLOUD_BASE_URL` | `.env` 或部署环境变量 | 不把真实 URL、Key 写入文档或提交 Git |
| 云端控制面仓库 | `C:\Users\Administrator\Documents\Codex\2026-07-17\zhenjian-platform` | API / 部署代码在此仓库 | 工作树也为 dirty；远端仓库需由负责人确认，不能假定模板 remote 可发布 |
| 云端 Agent Turn API | `zhenjian-platform\app\api\v1\agent-turns\`、`lib\agents\` | `POST /api/v1/agent-turns` | 新 Local Agent 路径使用无状态单轮模型推理，不能创建旧 task / command |
| 云端旧 Agent / Bridge API | `zhenjian-platform\app\api\v1\agent-runs\`、`app\api\bridge\` | 搜索 `agent-runs`、`task_commands` | 旧 CommandPack 链路；不能混同为新产品闭环 |
| 云端部署配置 | `zhenjian-platform\deploy\docker-compose.staging.yml` | 约定部署目录 `/opt/zhenjian-platform-staging` | 服务通常仅监听 `127.0.0.1:3000`，通过 SSH 隧道或网关访问；实际主机 / TLS 由部署负责人确认 |
| 已知产品域名 | `freecut.net`、`https://123jianhao.com/dashboard` | DNS、网关和部署清单由运维确认 | 本文不记录 IP、SSH 指纹、Token 或账号 |
| 构建产物 | `D:\Codex\freecut\dist\`、`D:\Codex\freecut\dist-electron\` | `npm run desktop:build` | `dist-electron` 是 Electron Main / Preload 的当前编译产物 |
| Windows 打包 | `D:\Codex\freecut\electron-builder.yml`、`scripts\release-windows.mjs` | `npm run desktop:release` 或 `npm run desktop:dist` | 发布前必须确认更新源和签名配置 |
| Main 日志 | `<Electron userData>\logs\main.log` | 隔离环境中由 Electron `app.getPath('logs')` 决定 | 用于本地诊断；不要上传含项目正文或凭据的日志 |
| Agent 私有存储 | `<Electron userData>\private\agent-runtime` | 在隔离 userData 下检查 | 唯一的 Thread / Run / Receipt 持久化位置 |
| 本地凭据 | `<Electron userData>\private\credentials.json` | 仅由 Electron safeStorage 使用 | 绝不读取、复制、打印或提交其中的 Key |
| Bridge 连接信息 | `<Electron userData>\bridge.json` | 由 Main 创建 | 含 Bearer 凭据，绝不写入问题单或交接材料 |

## 当前系统边界

| 边界 | 约束 |
| --- | --- |
| 模型请求 | 每一个上游模型 HTTP / 流式连接最多 120 秒；一个复杂 Run 可以由多轮独立请求组成 |
| Agent 子任务 | 本地默认并行 4 个，只读子任务上限可配到 50；不得让子任务直接写时间线 |
| 时间线写入 | 仅一个本地写入者；必须经过审批、lease、fencing、idempotency、readback 和 ACK |
| 素材出站 | 可按当前任务发送用户选定音频片段、关键帧或低码率代理给 ASR / 多模态 Provider；不自动上传整个工程或素材库 |
| 云端保留 | 云端不持久化用户正文、完整 ContextPack、原始素材或模型原始输出；本地保存必要的脱敏 Receipt 与状态 |
| 模型替换 | UI 只传 Profile；云端 Router 决定 Provider / Model / Version，避免每次换模型修改客户端协议 |

## 已通过的本地验证

| 命令 | 结果 | 时间 |
| --- | --- | --- |
| `npm run desktop:test` | `29` 个文件、`135` 个测试通过 | 2026-07-25 |
| `npm run desktop:check` | `73` 个文件无类型 / lint 错误 | 2026-07-25 |
| `npm run desktop:build` | 待本轮收尾再次运行 | 2026-07-25 |

针对本轮问题新增的覆盖包括：

- 侧栏已确认写操作不会触发 Bridge 的二次原生确认。
- 本地审批会带入 `confirmedByLocalAgent`，并使用 lease 内的 120 秒执行窗口。
- 续租失败不会下发写工具，返回可恢复的 `LOCAL_AGENT_APPROVAL_EXPIRED`。
- UI 优先显示可恢复审批错误，而非裸露 `STALE_FENCE`。
- 快速 / 专家 Profile 映射不绑定具体上游模型。

## 下一位负责人的最短接手顺序

1. 在不修改真实项目的前提下，创建新的隔离 workspace 与 userData。
2. 运行 `npm run desktop:build`、`npm run desktop:test`、`npm run desktop:check`。
3. 启动隔离 Electron，打开侧栏设置，确认“快速 / 专家”按钮可见且选择可保存。
4. 让 Agent 生成一个可写操作，在侧栏点击一次“确认并执行”。
5. 验证没有 Windows 二次确认；检查结果不是 `STALE_FENCE`，并确认 readback 与时间线状态一致。
6. 再进行云端 Agent Turn 的独立在线验收：Profile 路由、120 秒首事件 / 总时限、错误分型和不持久化扫描。

## 尚未关闭的风险

- 云端生产域名、TLS、网关和部署状态需要运维使用实际环境确认。
- Renderer、Electron、云端 Agent Turn 的完整联合 E2E 尚未作为一个整体完成验收。
- 两个仓库均为重度 dirty 状态；任何交接者都必须避免重置、批量格式化或覆盖其他工作线。
- 本地隔离 Electron 的手工写入闭环需要在新编译 Main 加载后完成最后一次人工验证。
