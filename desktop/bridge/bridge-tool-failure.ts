/**
 * Renderer tool calls never reject: `callMcpTool` catches every throw and
 * returns a resolved `McpCallResult` carrying `isError: true` (and a
 * `structuredContent.ok === false` payload). A resolved Bridge promise
 * therefore proves only that the renderer answered, not that the tool
 * succeeded, so every caller must inspect the payload before reporting
 * success.
 *
 * The Renderer's cloud path does this in `getToolFailure`
 * (src/features/editor/components/freecut-bridge-runner.tsx). Desktop code
 * cannot import from `src/`, so the same rule lives here for the local Agent
 * Host.
 */
export interface BridgeToolFailure {
  code: string
  message: string
}

const DEFAULT_FAILURE_MESSAGE = '本地命令执行失败。'
const DEFAULT_FAILURE_CODE = 'TOOL_EXECUTION_FAILED'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function readErrorFields(structured: Record<string, unknown>): BridgeToolFailure | null {
  const error = asRecord(structured.error)
  if (!error) return null
  const message = typeof error.message === 'string' ? error.message.trim() : ''
  const code = typeof error.code === 'string' ? error.code.trim() : ''
  if (!message && !code) return null
  return {
    code: code || DEFAULT_FAILURE_CODE,
    message: message || DEFAULT_FAILURE_MESSAGE,
  }
}

function readContentText(result: Record<string, unknown>): string {
  if (!Array.isArray(result.content)) return ''
  for (const entry of result.content) {
    const item = asRecord(entry)
    const text = item && typeof item.text === 'string' ? item.text.trim() : ''
    if (text) return text
  }
  return ''
}

/**
 * Returns the failure carried by a resolved Bridge tool result, or `null` when
 * the call genuinely succeeded. A non-object result (or one without the MCP
 * failure markers) is treated as success so that tools returning plain values
 * keep working.
 */
export function getBridgeToolFailure(result: unknown): BridgeToolFailure | null {
  const record = asRecord(result)
  if (!record) return null

  const structured = asRecord(record.structuredContent)
  const failedStructured = structured !== null && structured.ok === false
  if (record.isError !== true && !failedStructured) return null

  const fromError = structured ? readErrorFields(structured) : null
  if (fromError) return fromError

  const structuredMessage =
    structured && typeof structured.message === 'string' ? structured.message.trim() : ''
  return {
    code: DEFAULT_FAILURE_CODE,
    message: structuredMessage || readContentText(record) || DEFAULT_FAILURE_MESSAGE,
  }
}
