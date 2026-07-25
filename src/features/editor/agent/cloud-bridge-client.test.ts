import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acknowledgeCloudBridgeTask,
  cancelCloudAgentRun,
  CloudAgentRunError,
  parseCloudBridgePollResponse,
  pollCloudBridge,
  runCloudAgent,
  type CloudAgentRunProgress,
} from './cloud-bridge-client'
import {
  CLOUD_COMMAND_CONTRACT_ID,
  CLOUD_COMMAND_VERSION,
  listCloudCommandCapabilities,
} from './cloud-command-contract'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function pollResponse(commandVersion: 2 | '2') {
  return {
    deviceId: 'device-1',
    task: {
      id: 'task-1',
      projectId: 'project-1',
      projectName: 'Fixture',
      status: 'claimed',
      commandVersion,
      commandContractId: CLOUD_COMMAND_CONTRACT_ID,
      attempt: 3,
      commands: [
        {
          sequence: 0,
          commandId: 'command-1',
          type: 'timeline.read_project',
          params: {},
        },
      ],
    },
  }
}

describe('cloud bridge client wire contract', () => {
  it('routes web agent requests through the same-origin development proxy', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: 'run-1',
            status: 'accepted',
            eventsUrl: '/api/v1/agent-runs/run-1/events',
          }),
          {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          runId: 'run-1',
          status: 'completed',
          taskId: 'task-1',
          error: null,
          result: {
            taskId: 'task-1',
            status: 'succeeded',
            commandPackage: {
              version: 2,
              operations: [],
            },
            execution: {
              status: 'succeeded',
              commandCount: 0,
            },
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
      )
    globalThis.fetch = fetchMock

    const result = runCloudAgent(
      { baseUrl: 'https://api.freecut.example', businessKey: '测试-key' },
      {
        deviceId: 'device-1',
        businessModel: 'smart-edit-fast',
        commandVersion: CLOUD_COMMAND_VERSION,
        commandContractId: CLOUD_COMMAND_CONTRACT_ID,
        prompt: '测试',
        idempotencyKey: 'request-1',
      },
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await result

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/__freecut_dev_mcp/api/v1/agent-runs')
    expect(requestInit.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-FreeCut-Business-Key': encodeURIComponent('测试-key'),
    })
    expect(requestInit.headers).not.toHaveProperty('Authorization')
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      executionMode: 'bridge',
    })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/__freecut_dev_mcp/api/v1/agent-runs/run-1')
  })

  it('reports structured run progress while waiting for the final command package', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: 'run-1',
            taskId: 'task-1',
            status: 'accepted',
            eventsUrl: '/api/v1/agent-runs/run-1/events',
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: 'run-1',
            taskId: 'task-1',
            status: 'planning',
            phase: 'ANALYZING',
            progress: {
              current: 12,
              total: 50,
            },
            summary: '正在分析画面结构',
            error: null,
            result: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: 'run-1',
            taskId: 'task-1',
            status: 'completed',
            phase: 'COMPLETED',
            error: null,
            result: {
              taskId: 'task-1',
              status: 'succeeded',
              commandPackage: { version: 2, operations: [] },
              execution: { status: 'succeeded', commandCount: 0 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    globalThis.fetch = fetchMock
    const progress: CloudAgentRunProgress[] = []

    const result = runCloudAgent(
      { baseUrl: 'https://api.freecut.example', businessKey: '测试-key' },
      {
        deviceId: 'device-1',
        businessModel: 'smart-edit-expert',
        commandVersion: CLOUD_COMMAND_VERSION,
        commandContractId: CLOUD_COMMAND_CONTRACT_ID,
        prompt: '测试',
        idempotencyKey: 'request-1',
      },
      undefined,
      (update) => progress.push(update),
    )
    await vi.advanceTimersByTimeAsync(2_000)
    await result

    expect(progress).toMatchObject([
      { runId: 'run-1', taskId: 'task-1', phase: 'ACCEPTED' },
      {
        runId: 'run-1',
        phase: 'ANALYZING',
        progressCurrent: 12,
        progressTotal: 50,
        summary: '正在分析画面结构',
      },
      { runId: 'run-1', phase: 'COMPLETED' },
    ])
  })

  it('uses only completed metadata even if a legacy direct result is present', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: 'run-1',
            taskId: 'task-1',
            status: 'ACCEPTED',
            eventsUrl: '/api/v1/agent-runs/run-1/events',
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: 'run-1',
            taskId: 'task-1',
            status: 'COMPLETED',
            phase: 'COMPLETED',
            progress: null,
            errorCode: null,
            commandPackage: {
              contractId: CLOUD_COMMAND_CONTRACT_ID,
              version: 2,
              summary: '已生成命令。',
              operations: [],
            },
            execution: {
              status: 'succeeded',
              commandCount: 0,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    globalThis.fetch = fetchMock

    const promise = runCloudAgent(
      { baseUrl: 'https://api.freecut.example', businessKey: '测试-key' },
      {
        deviceId: 'device-1',
        businessModel: 'smart-edit-fast',
        commandVersion: CLOUD_COMMAND_VERSION,
        commandContractId: CLOUD_COMMAND_CONTRACT_ID,
        prompt: '测试',
        idempotencyKey: 'request-1',
      },
    )

    await vi.advanceTimersByTimeAsync(1_000)
    await expect(promise).resolves.toEqual({
      runId: 'run-1',
      taskId: 'task-1',
      status: 'COMPLETED',
      phase: 'COMPLETED',
      commandPackage: {
        contractId: CLOUD_COMMAND_CONTRACT_ID,
        version: 2,
      },
    })
  })

  it('preserves structured failure and request metadata', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: 'run-1',
            taskId: 'task-1',
            status: 'ACCEPTED',
            statusUrl: '/api/v1/agent-runs/run-1',
            eventsUrl: '/api/v1/agent-runs/run-1/events',
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: 'run-1',
            taskId: 'task-1',
            status: 'FAILED',
            phase: 'FAILED',
            progress: {
              current: 2,
              total: 4,
            },
            error: {
              code: 'MODEL_FIRST_EVENT_TIMEOUT',
              message: '上游已建立连接，但未返回首个流事件。',
              stage: 'fast',
              retryable: true,
              request: {
                requestId: 'request-1',
                channelId: 'channel-1',
                upstreamModel: 'gpt-5.6-luna',
                upstreamCode: 'SSE_FIRST_EVENT_TIMEOUT',
                elapsedMs: 30_000,
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    globalThis.fetch = fetchMock
    const progress: CloudAgentRunProgress[] = []

    const promise = runCloudAgent(
      { baseUrl: 'https://api.freecut.example', businessKey: '测试-key' },
      {
        deviceId: 'device-1',
        businessModel: 'smart-edit-fast',
        commandVersion: CLOUD_COMMAND_VERSION,
        commandContractId: CLOUD_COMMAND_CONTRACT_ID,
        prompt: '测试',
        idempotencyKey: 'request-1',
      },
      undefined,
      (update) => progress.push(update),
    )
    const rejection = expect(promise).rejects.toMatchObject({
      name: 'CloudAgentRunError',
      code: 'MODEL_FIRST_EVENT_TIMEOUT',
      runId: 'run-1',
      taskId: 'task-1',
      phase: 'FAILED',
      progressCurrent: 2,
      progressTotal: 4,
      stage: 'fast',
      retryable: true,
      request: {
        requestId: 'request-1',
        channelId: 'channel-1',
        upstreamModel: 'gpt-5.6-luna',
        upstreamCode: 'SSE_FIRST_EVENT_TIMEOUT',
        elapsedMs: 30_000,
      },
    })

    await vi.advanceTimersByTimeAsync(1_000)
    await rejection
    expect(progress.at(-1)).toMatchObject({
      runId: 'run-1',
      taskId: 'task-1',
      phase: 'FAILED',
      errorCode: 'MODEL_FIRST_EVENT_TIMEOUT',
      stage: 'fast',
      request: {
        requestId: 'request-1',
        channelId: 'channel-1',
      },
    })
  })

  it('completes from Bridge metadata without requiring command operations', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: 'run-1',
            taskId: 'task-1',
            status: 'ACCEPTED',
            eventsUrl: '/api/v1/agent-runs/run-1/events',
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: 'run-1',
            taskId: 'task-1',
            status: 'COMPLETED',
            phase: 'COMPLETED',
            progress: null,
            errorCode: null,
            commandPackage: {
              contractId: CLOUD_COMMAND_CONTRACT_ID,
              version: 2,
              manifestHash: 'sha256:manifest',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    globalThis.fetch = fetchMock

    const promise = runCloudAgent(
      { baseUrl: 'https://api.freecut.example', businessKey: '测试-key' },
      {
        deviceId: 'device-1',
        businessModel: 'smart-edit-fast',
        commandVersion: CLOUD_COMMAND_VERSION,
        commandContractId: CLOUD_COMMAND_CONTRACT_ID,
        prompt: '测试',
        idempotencyKey: 'request-1',
      },
    )
    const completion = expect(promise).resolves.toEqual({
      runId: 'run-1',
      taskId: 'task-1',
      status: 'COMPLETED',
      phase: 'COMPLETED',
      commandPackage: {
        contractId: CLOUD_COMMAND_CONTRACT_ID,
        version: 2,
        manifestHash: 'sha256:manifest',
      },
    })

    await vi.advanceTimersByTimeAsync(1_000)
    await completion
  })

  it('stops local polling on the client deadline without cancelling the cloud run', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: 'run-1',
            taskId: 'task-1',
            status: 'ACCEPTED',
            eventsUrl: '/api/v1/agent-runs/run-1/events',
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              runId: 'run-1',
              taskId: 'task-1',
              status: 'ANALYZING',
              phase: 'ANALYZING',
              progress: { current: 1, total: 4 },
              errorCode: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      )
    globalThis.fetch = fetchMock

    const promise = runCloudAgent(
      { baseUrl: 'https://api.freecut.example', businessKey: '测试-key' },
      {
        deviceId: 'device-1',
        businessModel: 'smart-edit-expert',
        commandVersion: CLOUD_COMMAND_VERSION,
        commandContractId: CLOUD_COMMAND_CONTRACT_ID,
        prompt: '测试',
        idempotencyKey: 'request-1',
      },
      undefined,
      undefined,
      {
        pollIntervalMs: 1_000,
        totalTimeoutMs: 2_500,
      },
    )
    const rejection = expect(promise).rejects.toMatchObject({
      name: 'CloudAgentRunError',
      code: 'CLIENT_AGENT_RUN_TIMEOUT',
      runId: 'run-1',
      taskId: 'task-1',
      phase: 'ANALYZING',
      remoteRunContinues: true,
    })

    await vi.advanceTimersByTimeAsync(3_000)
    await rejection
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      '/__freecut_dev_mcp/api/v1/agent-runs/run-1/cancel',
    )
  })

  it('enforces the client deadline while a status request is still pending', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: 'run-1',
            taskId: 'task-1',
            status: 'ACCEPTED',
            eventsUrl: '/api/v1/agent-runs/run-1/events',
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockImplementation((_url, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          )
        }),
      )
    globalThis.fetch = fetchMock

    const promise = runCloudAgent(
      { baseUrl: 'https://api.freecut.example', businessKey: '测试-key' },
      {
        deviceId: 'device-1',
        businessModel: 'smart-edit-expert',
        commandVersion: CLOUD_COMMAND_VERSION,
        commandContractId: CLOUD_COMMAND_CONTRACT_ID,
        prompt: '测试',
        idempotencyKey: 'request-1',
      },
      undefined,
      undefined,
      {
        pollIntervalMs: 1_000,
        totalTimeoutMs: 2_500,
      },
    )
    const rejection = expect(promise).rejects.toMatchObject({
      code: 'CLIENT_AGENT_RUN_TIMEOUT',
      runId: 'run-1',
      taskId: 'task-1',
      phase: 'ACCEPTED',
      remoteRunContinues: true,
    })

    await vi.advanceTimersByTimeAsync(3_000)
    await rejection
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      '/__freecut_dev_mcp/api/v1/agent-runs/run-1/cancel',
    )
  })

  it('exposes CloudAgentRunError progress for store-level diagnostics', () => {
    const error = new CloudAgentRunError(
      '上游请求失败。',
      {
        runId: 'run-1',
        taskId: 'task-1',
        status: 'FAILED',
        phase: 'FAILED',
        errorCode: 'MODEL_UPSTREAM_RESPONSE_FAILED',
        error: '上游请求失败。',
        stage: 'director',
      },
      { code: 'MODEL_UPSTREAM_RESPONSE_FAILED' },
    )

    expect(error.progress).toMatchObject({
      runId: 'run-1',
      taskId: 'task-1',
      phase: 'FAILED',
      stage: 'director',
    })
  })

  it('uses the bounded cancel endpoint for an accepted run', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ runId: 'a15c7220-469b-4fcc-85da-e31f6512539e', status: 'cancelled' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    globalThis.fetch = fetchMock

    await cancelCloudAgentRun(
      { baseUrl: 'https://api.freecut.example', businessKey: 'temporary-key' },
      'a15c7220-469b-4fcc-85da-e31f6512539e',
    )

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/__freecut_dev_mcp/api/v1/agent-runs/a15c7220-469b-4fcc-85da-e31f6512539e/cancel',
    )
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
  })

  it.each([2, '2'] as const)('normalizes task command version %s to numeric v2', (version) => {
    const parsed = parseCloudBridgePollResponse(pollResponse(version))
    expect(parsed.task?.commandVersion).toBe(2)
    expect(parsed.task?.attempt).toBe(3)
  })

  it('sends numeric v2 and generated capabilities on every poll', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ deviceId: 'device-1', task: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    globalThis.fetch = fetchMock

    await pollCloudBridge(
      { baseUrl: 'https://api.freecut.example', businessKey: 'temporary-key' },
      {
        deviceId: 'device-1',
        name: 'FreeCut client',
        platform: 'windows',
        clientVersion: '1.0.1',
        commandVersion: CLOUD_COMMAND_VERSION,
        commandContractId: CLOUD_COMMAND_CONTRACT_ID,
        commandCapabilities: listCloudCommandCapabilities(),
        currentProjectId: 'project-1',
      },
    )

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(requestInit.body)) as Record<string, unknown>
    expect(body.commandVersion).toBe(3)
    expect(body.commandContractId).toBe('freecut.editor.commands.v3')
    expect(body.commandCapabilities).toEqual(listCloudCommandCapabilities())
  })

  it('keeps the task attempt and structured Renderer receipt on acknowledgements', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          taskId: 'task-1',
          attempt: 3,
          status: 'completed',
          retryable: false,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )
    globalThis.fetch = fetchMock

    const response = await acknowledgeCloudBridgeTask(
      { baseUrl: 'https://api.freecut.example', businessKey: 'temporary-key' },
      {
        deviceId: 'device-1',
        taskId: 'task-1',
        attempt: 3,
        results: [
          {
            sequence: 0,
            commandId: 'command-1',
            type: 'timeline.read_project',
            attempt: 3,
            status: 'succeeded',
            requestId: 'request-1',
            operationId: 'operation-1',
            changed: true,
            projectRevision: 'revision-2',
            changeSummary: 'Added one text item.',
            finalStatus: 'succeeded',
            error: null,
            warnings: [{ code: 'TEST_WARNING', message: 'warning' }],
            operationManifest: {
              contractId: CLOUD_COMMAND_CONTRACT_ID,
              commandId: 'command-1',
              commandType: 'timeline.read_project',
              tool: 'read_project',
              projectId: 'project-1',
              sequence: 0,
              attempt: 3,
              idempotencyKey: 'operation-1',
              argsFingerprint: 'fnv1a64:args',
              commitMode: 'none',
              expectedBeforeSnapshotId: 'snapshot-before',
              expectedBeforeFingerprint: 'fnv1a64:before',
              postReadAssertions: [{ path: 'timeline.itemCount', operator: 'equals', expected: 1 }],
              impactFlags: ['semantic'],
              requiresPostReadback: true,
            },
            phaseReceipts: [
              { phase: 'transport', status: 'succeeded' },
              { phase: 'postReadback', status: 'succeeded' },
            ],
            impactFlags: ['semantic'],
            reconciliationStatus: 'VERIFIED_APPLIED',
            reconciliation: {
              observedAt: '2026-07-22T00:00:00.000Z',
              method: 'renderer-post-readback',
              status: 'applied',
              retryAttempted: false,
              newTaskCreated: false,
              newCommandCreated: false,
            },
            beforeSnapshotId: 'snapshot-before',
            afterSnapshotId: 'snapshot-after',
            beforeFingerprint: 'fnv1a64:before',
            afterFingerprint: 'fnv1a64:after',
            postReadback: {
              status: 'verified',
              snapshotId: 'snapshot-after',
              fingerprint: 'fnv1a64:after',
              assertions: [{ path: 'timeline.itemCount', operator: 'equals', expected: 1 }],
            },
          },
        ],
      },
    )

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(requestInit.body)) as {
      attempt: number
      results: Array<Record<string, unknown>>
    }
    expect(body.attempt).toBe(3)
    expect(body.results[0]).toMatchObject({
      requestId: 'request-1',
      operationId: 'operation-1',
      changed: true,
      projectRevision: 'revision-2',
      changeSummary: 'Added one text item.',
      finalStatus: 'succeeded',
      operationManifest: {
        idempotencyKey: 'operation-1',
        impactFlags: ['semantic'],
      },
      phaseReceipts: [
        { phase: 'transport', status: 'succeeded' },
        { phase: 'postReadback', status: 'succeeded' },
      ],
      impactFlags: ['semantic'],
      reconciliationStatus: 'VERIFIED_APPLIED',
      reconciliation: { status: 'applied' },
      beforeSnapshotId: 'snapshot-before',
      afterSnapshotId: 'snapshot-after',
      beforeFingerprint: 'fnv1a64:before',
      afterFingerprint: 'fnv1a64:after',
      postReadback: {
        status: 'verified',
        snapshotId: 'snapshot-after',
      },
    })
    expect(response).toMatchObject({ taskId: 'task-1', status: 'completed' })
  })
})
