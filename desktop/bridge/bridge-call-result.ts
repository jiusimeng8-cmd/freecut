import type {
  DesktopBridgeFailureStatus,
  DesktopBridgeRequest,
} from '../desktop-types'

export function createBridgeFailureResult(
  input: Pick<DesktopBridgeRequest, 'requestId'>,
  error: {
    code: string
    message: string
    finalStatus?: DesktopBridgeFailureStatus
  },
) {
  const finalStatus = error.finalStatus ?? 'failed'
  return {
    content: [{ type: 'text' as const, text: error.message }],
    isError: true,
    structuredContent: {
      ok: false,
      message: error.message,
      requestId: input.requestId,
      operationId: input.requestId,
      changed: false,
      projectRevision: null,
      changeSummary: null,
      finalStatus,
      error: {
        code: error.code,
        message: error.message,
      },
      warnings: [],
    },
  }
}
