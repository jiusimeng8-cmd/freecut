# FreeCut Web MCP 错误报告

## 基本信息

- 报告编号：`FC-WEB-MCP-20260721-001`
- 日期：`2026-07-21`
- 产品：FreeCut Web
- 复现页面：`http://localhost:5173/editor/e2JJlJt0`
- 当前状态：浏览器跨域问题已修复；云端模型渠道失败仍未闭环
- 敏感信息：未读取、记录或输出真实 MCP Key、Authorization、渠道密钥

## 用户现象

AI 对话面板先出现：

```text
请求失败：Failed to fetch
```

开发代理修复后，错误变为：

```text
请求失败：所有供应渠道均调用失败。
```

截图现场当前选择的是“专家 X2”模式。手动时间线编辑、预览和本地功能不受该错误影响。

## 事件分层

### 事件 A：浏览器 CORS 阻断，已解决

原始 Web 请求从 `http://localhost:5173` 直接访问云端 Agent API。预检请求虽然返回 `204`，但没有返回 `Access-Control-Allow-Origin`，浏览器在真正发送带 Authorization 的 POST 之前直接阻断，因此前端只能得到 `TypeError: Failed to fetch`。

已做的最小修复：

- Web 开发环境改走同源路径 `/__freecut_dev_mcp`。
- Vite 代理只允许转发：
  - `/api/v1/agents/run`
  - `/api/bridge/poll`
  - `/api/bridge/ack`
- 浏览器通过 `X-FreeCut-Business-Key` 传给本机开发代理，代理再生成云端 Authorization。
- Electron Main 请求分支未改变。

验证证据：

- 浏览器假 Key 请求代理后收到云端 `401` JSON，而不是 `Failed to fetch`。
- 编辑器页面返回 `HTTP 200`。
- 相关定向测试 `10/10` 通过。
- 生产构建通过。

### 事件 B：云端模型渠道全部失败，当前阻塞

当前错误来自云端的业务层，不是浏览器或 Vite 代理生成的。云端代码在 `withRoutedModelChannel()` 中按业务模型遍历 active 渠道；每个渠道的调用抛错后，统一返回：

```text
所有供应渠道均调用失败。
```

云端 Agent 当前使用 OpenAI Agents SDK，并固定启用 `useResponses: true`。因此当前仍需从云端脱敏日志区分具体原因。

## 已排除事项

- 不是本地页面无法访问。
- 不是 CORS 修复后请求未到达云端。
- 不是 FreeCut 时间线、Renderer 或 Bridge 执行层错误。
- 不是客户端命令 Schema 校验错误的直接提示。
- 余额不足、业务 Key 无效、设备未连接等错误在云端有独立错误分支；当前返回的是渠道调用统一兜底。

## 未确认的根因假设

按优先级排列：

1. `smart-edit-expert` 对应渠道的上游 Key、额度或网络不可用。
2. 渠道 `baseURL`、`upstreamModel` 或协议配置与 `/v1/responses` 不匹配。
3. 上游兼容 OpenAI Chat Completions，但不兼容 Agents SDK 使用的 Responses API。
4. 上游返回的结构化输出不满足固定 FreeCut 命令 Schema，异常被渠道路由层统一吞掉。
5. 快速版和专家版共用的渠道配置同时失效。

## 影响评估

- 影响：Web 内置 AI Agent 无法生成剪辑计划，AI 自动剪辑链路不可用。
- 不影响：手动剪辑、时间线本地读写、预览、导出以及 Electron 的本地 IPC。
- 风险：不建议客户端自动把专家模式降级为快速模式，否则会绕过 `X2` 计费语义。

## 建议修复顺序

### 云端侧

1. 只读核对 `smart-edit-fast`、`smart-edit-expert` 的 active 模型和渠道数量。
2. 查看对应请求的脱敏错误原因：HTTP 状态、超时、协议路径、上游模型名；禁止记录 Key。
3. 用已授权的测试渠道验证 `/v1/responses`、结构化输出和 Agents SDK 兼容性。
4. 给统一错误增加稳定错误码，例如 `MODEL_CHANNEL_ALL_FAILED`，并在服务端日志保留脱敏失败分类。
5. 修复并分别验证快速版、专家版；不要用客户端吞错或自动降级替代云端修复。

### 客户端侧

当前没有必须继续修改的客户端代码。可暂时切换到“快速”模式做隔离测试：

- 快速成功、专家失败：专家渠道或专家请求链问题。
- 两者都失败：共用上游渠道、路由或 Responses 兼容性问题。

## 本地改动与验证

本轮相关文件：

- `src/features/editor/agent/cloud-bridge-client.ts`
- `src/features/editor/agent/cloud-bridge-client.test.ts`
- `scripts/dev-cloud-asr-plugin.ts`

验证命令：

```text
npx vp test run src/features/editor/agent/cloud-bridge-client.test.ts src/features/editor/agent/agent-store.test.ts
npm.cmd run build
npx vp check --no-fmt src/features/editor/agent/cloud-bridge-client.ts src/features/editor/agent/cloud-bridge-client.test.ts scripts/dev-cloud-asr-plugin.ts
```

结果：

- 定向测试：`10/10` 通过
- 生产构建：通过
- 页面健康检查：`HTTP 200`
- 真实 Key：未读取、未输出
- 云端配置：未修改

## 当前结论

`Failed to fetch` 已经修复。当前剩余错误是云端供应渠道/上游 Agent 调用故障，责任边界在云端模型路由与渠道配置，不在 FreeCut Web 客户端。精确根因需要云端脱敏运行日志或渠道管理员修复后再做真实回归。
