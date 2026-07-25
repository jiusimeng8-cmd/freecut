// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import { createBridgeFailureResult } from './bridge-call-result'

describe('createBridgeFailureResult', () => {
  it('returns the complete standard receipt for a Main or IPC failure', () => {
    expect(
      createBridgeFailureResult(
        { requestId: 'bridge-request-1' },
        {
          code: 'CONFIRMATION_TIMEOUT',
          message: 'Bridge confirmation timed out.',
          finalStatus: 'failed',
        },
      ),
    ).toEqual({
      content: [{ type: 'text', text: 'Bridge confirmation timed out.' }],
      isError: true,
      structuredContent: {
        ok: false,
        message: 'Bridge confirmation timed out.',
        requestId: 'bridge-request-1',
        operationId: 'bridge-request-1',
        changed: false,
        projectRevision: null,
        changeSummary: null,
        finalStatus: 'failed',
        error: {
          code: 'CONFIRMATION_TIMEOUT',
          message: 'Bridge confirmation timed out.',
        },
        warnings: [],
      },
    })
  })
})
