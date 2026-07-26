// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import { getBridgeToolFailure } from './bridge-tool-failure'

describe('getBridgeToolFailure', () => {
  it('treats plain values as success so non-MCP tool results keep working', () => {
    expect(getBridgeToolFailure({ clipCount: 3 })).toBeNull()
    expect(getBridgeToolFailure(undefined)).toBeNull()
    expect(getBridgeToolFailure(null)).toBeNull()
    expect(getBridgeToolFailure('done')).toBeNull()
    expect(getBridgeToolFailure(42)).toBeNull()
  })

  it('treats a successful MCP result as success', () => {
    expect(
      getBridgeToolFailure({
        content: [{ type: 'text', text: 'Imported 3 media items.' }],
        isError: false,
        structuredContent: { ok: true, message: 'Imported 3 media items.', changed: true },
      }),
    ).toBeNull()
  })

  it('reads the structured error code and message', () => {
    expect(
      getBridgeToolFailure({
        isError: true,
        structuredContent: {
          ok: false,
          message: 'fallback',
          error: { code: 'INVALID_ARGUMENTS', message: 'path is required' },
        },
      }),
    ).toEqual({ code: 'INVALID_ARGUMENTS', message: 'path is required' })
  })

  it('detects ok: false even when isError is absent', () => {
    expect(
      getBridgeToolFailure({ structuredContent: { ok: false, message: '没有可导入的文件。' } }),
    ).toEqual({ code: 'TOOL_EXECUTION_FAILED', message: '没有可导入的文件。' })
  })

  it('falls back to the content text when no structured message exists', () => {
    expect(
      getBridgeToolFailure({
        content: [{ type: 'text', text: 'Local path access was not approved.' }],
        isError: true,
      }),
    ).toEqual({
      code: 'TOOL_EXECUTION_FAILED',
      message: 'Local path access was not approved.',
    })
  })

  it('falls back to a default message when the payload carries no detail', () => {
    expect(getBridgeToolFailure({ isError: true })).toEqual({
      code: 'TOOL_EXECUTION_FAILED',
      message: '本地命令执行失败。',
    })
    expect(getBridgeToolFailure({ isError: true, content: [{ type: 'text', text: '  ' }] })).toEqual(
      { code: 'TOOL_EXECUTION_FAILED', message: '本地命令执行失败。' },
    )
  })

  it('ignores an error object that carries no usable code or message', () => {
    expect(
      getBridgeToolFailure({
        isError: true,
        structuredContent: { ok: false, message: 'tool blew up', error: {} },
      }),
    ).toEqual({ code: 'TOOL_EXECUTION_FAILED', message: 'tool blew up' })
  })
})
