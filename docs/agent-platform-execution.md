# 剪好侧边栏 Agent 平台执行计划

## 目标

把剪好侧边栏从“云端生成最终 CommandPack，再由客户端执行”迁移为
Codex 式的本地 Agent Host：

```text
用户消息
→ 本地 Run / Thread / Checkpoint
→ 云端单轮 Director 推理
→ 本地 MCP 工具调用
→ 本地 ToolReceipt / 媒体 Job / 审批
→ 回灌下一轮 Director
→ 最终答复或受控时间线写入
```

Electron Main 是 Agent 的控制面和用户内容的事实源。Renderer 仅订阅
事件并展示消息、进度、审批和验证结果。此项目没有历史用户数据或兼容性
承诺：侧边栏直接切换到新 Agent Turn / Local Director 合同，旧 Cloud
CommandPack 路径不得作为新产品路径或新接口的兼容分支。

## 固定边界

- Thread、Turn、Run、Event、Checkpoint、ToolReceipt、媒体分析缓存和证据
  仅持久化到 `<userData>\\private\\agent-runtime`。
- 云端可临时接收用户消息、选中的音频片段、关键帧、低码率代理和必要上下文，
  用于当前配置的 Director、视觉和 ASR Provider 推理；业务数据库不得保存这些
  正文或素材。
- 每次上游 GPT 请求的连接 deadline 为 120 秒。ASR 和媒体分析是独立异步
  Job，不能占用一条 Agent Turn 连接等待完成。
- 子 Agent 默认并行 4 个，可配置最大 50 个；子 Agent 只读。单条时间线始终
  只有一个本地写入者。
- 写工具必须继续走现有 lease、fencing、snapshot、idempotency、readback
  路径，不能由 Director 直接裸调用编辑器工具。
- MCP 是工具协议；GPT-5.6 流式 Agent Turn 是模型推理协议，二者不能混同。

## 产品状态机

```text
CREATED
→ CONTEXT_READY
→ THINKING
→ WAITING_TOOL
→ WAITING_MEDIA
→ WAITING_APPROVAL
→ EXECUTING
→ VERIFYING
→ COMPLETED

终态：FAILED / CANCELLED / UNKNOWN_WRITE
```

所有状态变化先写本地 Event / Checkpoint，再推送给 Renderer。应用重启后，
Run 必须能从最后一次 Checkpoint 恢复为可诊断状态，不能伪造已完成。

## 模块划分

### Local Agent Host

目录：`desktop/agent-runtime/**`

- Director Loop：限制每个 Run 最多 12 轮，每轮最多 8 个工具调用。
- 使用本地 Thread Store 写入消息、ToolReceipt、事件与检查点。
- 读工具自动执行；写工具创建审批请求并交给现有受控 Bridge。
- 取消必须中止当前 Agent Turn 和未开始的工具 / 媒体 Job。

### 云端 Agent Turn 与 Provider 路由

目录：`zhenjian-platform/lib/agents/**`、`app/api/v1/agent-turns/**`

- `POST /api/v1/agent-turns` 是无状态、单轮的推理 API。
- 返回 `tool_calls` 或 `final`，不得创建 `tasks`、`task_commands`、
  `runtime_outbox` 或任何云端用户正文存储。
- 首个流事件、空闲事件和总请求均采用明确的可诊断超时错误。
- P0 使用新的 JSON Agent Turn 合同；后续增加流式事件时只保持新合同的结果
  语义，不承接旧 Cloud CommandPack 或 `businessModel` 接口。
- Agent 合同只表达能力需求（`director`、`vision`、`asr`、`text`）和可选的
  用户选择 `profileId`，不得把具体模型名、Provider 名或模型版本写死在 Renderer、
  MCP 工具、Thread Store、ContextPack 或 API 的联合类型中。云端 Router 根据
  可用渠道和 Profile 解析当前模型；回执仅记录实际 routing 元数据。
- 新 Agent Turn API 只接受 `profileId`，不接受或返回 `businessModel`。
  `smart-edit-fast`、`smart-edit-expert` 之类值若仍存在，仅是后台可配置的
  Profile 数据，不能再作为前后端硬编码联合类型或兼容字段。

### 本地 MCP Host 与媒体 Provider

目录：`src/features/editor/agent/tools/**`、`src/features/media-library/**`、
`desktop/**`

- 全量工具注册但按需发现：`agent.tool_search`、`agent.tool_describe` 后再
  暴露具体的 `freecut.*` 工具。
- `freecut.media.transcribe`：本地缓存检查、阿里 ASR 提交、异步状态与
  本地 ToolReceipt。
- `freecut.media.analyze_visuals`：本地抽帧 / 代理准备、当前配置的视觉
  Provider、缓存与 ToolReceipt。
- 每个外发素材形成仅本地保存的 OutboundAssetReceipt：
  Provider、asset / clip、范围、hash、字节数、用途、远端 Job、TTL /
  删除状态。不得保存 Key。

### Renderer Agent Event UI

目录：`src/features/editor/agent/**`、`src/features/editor/components/agent-chat-panel.tsx`

- UI 订阅本地 Event；不能依赖内存中一次性 Promise 才显示状态。
- 展示简短阶段：读取项目、转写、分析画面、等待确认、执行、验证。
- 不展示思维链、未校验参数、密钥、原始 Provider 请求或响应。

## Provider 与素材策略

```text
当前 ASR Provider（初始为阿里 ASR）:
  输入：本地选定音频片段或用户明确选定的完整音频
  输出：转录和时间戳
  生命周期：短请求提交 + 独立异步 Job

当前 Director / Vision Provider（初始为 GPT-5.6）:
  输入：用户消息、最小 ContextPack、工具摘要、选定关键帧 / 代理
  输出：流式回答、工具调用、专业分析
  生命周期：每轮单独的 120 秒 Agent Turn
```

项目默认采用“受控云端”：

- 可以外发当前任务需要的音频片段、关键帧、低码率代理。
- 不自动遍历和上传整个素材库、工程目录、绝对路径或密钥。
- 上传完整原始素材或整个项目，必须是用户明确发起的完整分析动作。
- ASR、视觉摘要、ToolReceipt、模型最终答复全部优先缓存到本地。

Provider 配置的稳定标识是用户可见的 Profile / capability，而不是模型名称：

```text
directorProfile: "editor-expert"
visionProfile: "visual-analysis"
asrProfile: "speech-to-text"
capabilities: ["streaming", "tool-calls", "image-input", "timestamps"]
```

当前路由实际选择的 `providerId`、`modelId`、`modelVersion` 只作为本地
Evidence / Receipt 元数据。升级或替换模型时更新 Router 配置和 capability
映射，不迁移 Run、MCP 工具或聊天数据。

## 并发与性能

```text
云端分析角色：默认 4，硬上限 50
本地工程读取：受调度器限制
同一 GPU / 转码队列：串行或小并发
同一时间线写入：严格 1
导出：严格 1
```

本地负责抽帧、切音频、代理生成、工程索引、缓存、工具执行和验证；云端负责
ASR、多模态理解和大模型推理。素材缓存键至少包含内容 hash、时间范围、分析
类型、模型 / Provider 版本和参数 hash。

## 交付顺序

1. P0：本地 Director Loop + `agent-turns` 客户端 + 本地 Event / Checkpoint。
2. P0：本地 MCP 动态工具发现和读取工具回灌。
3. P1：阿里 ASR MCP 工具、异步媒体 Job、缓存和外发证据。
4. P1：GPT-5.6 视觉分析 MCP 工具和按需帧 / 代理输入。
5. P1：写工具审批、Bridge 受控执行和 readback 事件。
6. P2：专业子 Agent、取消 / 恢复、SSE 回放和产品级观测。

## P0 验收

- 用户提交后立即本地创建 Run；UI 能看到 `THINKING`。
- Director 能调用至少两个只读 MCP 工具，并收到回灌结果后输出最终自然语言答复。
- 取消、120 秒超时、工具失败均有明确错误代码和本地 Event。
- 页面刷新或 Electron 重启后，可读取 Run 历史和最终 / 失败状态。
- 读工具不产生 timeline 写入；写入路径仍经 lease、fencing 和 readback。
- 云端代码和日志扫描不包含用户正文、媒体二进制、完整 ContextPack、工具原始结果。

## 当前并行写入范围

| 工作线 | 允许写入 |
| --- | --- |
| Local Director | `desktop/agent-runtime/**`、对应专属测试 |
| Cloud Turn | `zhenjian-platform/lib/agents/**`、`app/api/v1/agent-turns/**`、对应测试 |
| 媒体 MCP | `src/features/media-library/**`、新建的媒体工具文件、对应测试 |
| Agent UI / Client | `src/features/editor/agent/**`、`agent-chat-panel.tsx`、对应测试 |

跨范围接口先以本文件为准。不得回退、格式化或整理任何已有 dirty 改动。
