import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLOUD_COMMAND_CONTRACT_ID,
  CLOUD_IMPACT_FLAGS,
  CLOUD_COMMAND_TYPES,
  CLOUD_COMMAND_VERSION,
  LEGACY_CLOUD_COMMAND_CONTRACT_ID,
  LEGACY_CLOUD_COMMAND_TYPES,
  LEGACY_CLOUD_COMMAND_VERSION,
  listCloudCommandCapabilities,
  normalizeCloudCommandVersion,
  parseCloudCommandEnvelope,
} from './cloud-command-contract'
import { parseCloudBridgePollResponse, pollCloudBridge } from './cloud-bridge-client'
import { describeCloudCommand, parseCloudBridgeCommand } from './cloud-command-runner'
import { getEditorTool } from './tools'

const originalFetch = globalThis.fetch

const V2_COMMANDS = [
  ['timeline.read_project', 'read_project', null],
  ['timeline.read_timeline', 'read_timeline', null],
  ['timeline.read_media', 'read_media', null],
  ['timeline.find_clips', 'find_clips', null],
  ['timeline.search_transcript', 'search_transcript', null],
  ['timeline.import_local_media', 'import_local_media', null],
  ['timeline.generate_captions', 'generate_captions', null],
  ['timeline.split', 'split', null],
  ['timeline.delete_clips', 'delete_clips', 'clips'],
  ['timeline.remove_silence', 'remove_silence', 'clips'],
  ['timeline.trim_clip', 'trim_clip', 'clip'],
  ['timeline.move_clips', 'move_clips', 'items'],
  ['timeline.delete_items', 'delete_items', 'items'],
  ['timeline.place_media', 'place_media', null],
  ['timeline.add_text', 'add_text', null],
  ['timeline.update_subtitle', 'update_subtitle', 'item'],
  ['timeline.set_transform', 'set_transform', 'items'],
  ['timeline.set_keyframes', 'set_keyframes', null],
  ['timeline.set_volume', 'set_volume', 'clips'],
  ['timeline.set_audio', 'set_audio', 'items'],
  ['timeline.save_project', 'save_project', null],
  ['timeline.undo', 'undo', null],
  ['timeline.redo', 'redo', null],
  ['timeline.check_export', 'check_export', null],
  ['timeline.enqueue_export', 'enqueue_export', null],
  ['timeline.export_subtitles', 'export_subtitles', null],
] as const

const V3_COLOR_COMMANDS = [
  ['editor.list_effects', 'list_effects', null, 'read', 'diagnostics'],
  ['editor.apply_effect', 'apply_effect', 'items', 'creative', 'creative'],
  ['editor.manage_effect_preset', 'manage_effect_preset', 'items', 'color', 'creative'],
  [
    'editor.manage_color_grade_clipboard',
    'manage_color_grade_clipboard',
    'items',
    'color',
    'creative',
  ],
  ['editor.import_cube_lut', 'import_cube_lut', 'items', 'color', 'creative'],
  ['editor.balance_color', 'balance_color', 'items', 'color', 'creative'],
] as const

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('cloud command contract', () => {
  it('keeps the exact legacy v2 surface and publishes the v3 color contract', () => {
    const capabilities = listCloudCommandCapabilities()
    const legacyCapabilities = listCloudCommandCapabilities(LEGACY_CLOUD_COMMAND_VERSION)
    expect(LEGACY_CLOUD_COMMAND_VERSION).toBe(2)
    expect(LEGACY_CLOUD_COMMAND_CONTRACT_ID).toBe('freecut.timeline.commands.v2')
    expect(LEGACY_CLOUD_COMMAND_TYPES).toEqual(V2_COMMANDS.map(([type]) => type))
    expect(
      legacyCapabilities.map(({ type, tool, targetParam }) => [
        type,
        tool,
        targetParam ?? null,
      ]),
    ).toEqual(V2_COMMANDS)

    expect(CLOUD_COMMAND_VERSION).toBe(3)
    expect(typeof CLOUD_COMMAND_VERSION).toBe('number')
    expect(normalizeCloudCommandVersion(2)).toBe(2)
    expect(normalizeCloudCommandVersion('2')).toBe(2)
    expect(normalizeCloudCommandVersion(3)).toBe(3)
    expect(normalizeCloudCommandVersion('3')).toBe(3)
    expect(() => normalizeCloudCommandVersion('4')).toThrow('不支持')
    expect(CLOUD_COMMAND_CONTRACT_ID).toBe('freecut.editor.commands.v3')
    expect(CLOUD_COMMAND_TYPES).toEqual([
      ...V2_COMMANDS.map(([type]) => type),
      ...V3_COLOR_COMMANDS.map(([type]) => type),
    ])
    expect(
      capabilities.map(({ type, tool, targetParam }) => [type, tool, targetParam ?? null]),
    ).toEqual([
      ...V2_COMMANDS,
      ...V3_COLOR_COMMANDS.map(([type, tool, targetParam]) => [type, tool, targetParam]),
    ])
    expect(
      capabilities
        .filter((capability) => capability.type.startsWith('editor.'))
        .map(({ type, tool, targetParam, category, group }) => [
          type,
          tool,
          targetParam ?? null,
          category,
          group,
        ]),
    ).toEqual(V3_COLOR_COMMANDS)
    expect(new Set(capabilities.map((capability) => capability.type)).size).toBe(
      capabilities.length,
    )
    expect(new Set(capabilities.map((capability) => capability.tool)).size).toBe(
      capabilities.length,
    )

    for (const capability of capabilities) {
      expect(Object.keys(capability).sort()).toEqual(
        [
          'category',
          'destructive',
          'group',
          'handoff',
          'paramsSchema',
          'readOnly',
          'targetParam',
          'tool',
          'type',
        ].sort(),
      )
      expect(capability.paramsSchema.type).toBe('object')
      expect(capability.paramsSchema.additionalProperties).toBe(false)
      expect(getEditorTool(capability.tool)).toBeDefined()
    }
  })

  it('rejects unknown command types, fields, and non-object params', () => {
    expect(() =>
      parseCloudCommandEnvelope({
        sequence: 0,
        type: 'timeline.not_registered',
        params: {},
      }),
    ).toThrow('本地不支持')
    expect(() =>
      parseCloudCommandEnvelope({
        sequence: 0,
        type: 'timeline.read_project',
        params: [],
      }),
    ).toThrow('params 必须是 JSON 对象')
    expect(() =>
      parseCloudCommandEnvelope({
        sequence: 0,
        type: 'timeline.read_project',
        params: {},
        arbitrary: true,
      }),
    ).toThrow('未知字段')
  })

  it('keeps legacy v2 envelopes compatible and isolates v3-only color commands', () => {
    const legacy = parseCloudCommandEnvelope(
      {
        sequence: 0,
        type: 'timeline.read_timeline',
        params: { scope: 'main' },
      },
      2,
    )
    expect(legacy).toMatchObject({
      sequence: 0,
      type: 'timeline.read_timeline',
      params: { scope: 'main' },
    })
    expect(() =>
      parseCloudCommandEnvelope(
        {
          sequence: 0,
          type: 'editor.balance_color',
          params: { items: ['clip-1'], operation: 'auto_balance' },
        },
        2,
      ),
    ).toThrow('本地不支持')
    expect(
      parseCloudCommandEnvelope(
        {
          sequence: 0,
          type: 'editor.balance_color',
          params: { items: ['clip-1'], operation: 'auto_balance' },
        },
        3,
      ),
    ).toMatchObject({
      type: 'editor.balance_color',
      params: { items: ['clip-1'], operation: 'auto_balance' },
    })

    const extended = parseCloudCommandEnvelope({
      sequence: 1,
      type: 'timeline.add_text',
      commandId: 'command-1',
      idempotencyKey: 'operation-1',
      expectedBeforeFingerprint: 'fnv1a64:before',
      operationManifest: {
        commandId: 'command-1',
        idempotencyKey: 'operation-1',
        expectedBeforeFingerprint: 'fnv1a64:before',
        impactFlags: ['semantic', 'timing', 'motion'],
        requiresPostReadback: true,
      },
      postReadAssertions: [
        { path: 'timeline.textCount', operator: 'equals', expected: 1 },
        { path: 'history.undoCount', operator: 'notEquals', expected: 0 },
      ],
      params: { text: 'Keyword', atSeconds: 1, durationSeconds: 2 },
    })

    expect(extended).toMatchObject({
      commandId: 'command-1',
      idempotencyKey: 'operation-1',
      expectedBeforeFingerprint: 'fnv1a64:before',
      operationManifest: {
        impactFlags: ['semantic', 'timing', 'motion'],
        requiresPostReadback: true,
      },
      postReadAssertions: [
        { path: 'timeline.textCount', operator: 'equals', expected: 1 },
        { path: 'history.undoCount', operator: 'notEquals', expected: 0 },
      ],
    })
    expect(new Set(CLOUD_IMPACT_FLAGS).size).toBe(CLOUD_IMPACT_FLAGS.length)

    expect(() =>
      parseCloudCommandEnvelope({
        sequence: 2,
        type: 'timeline.add_text',
        operationManifest: { idempotencyKey: 'operation-1', arbitrary: true },
        params: { text: 'Keyword', atSeconds: 1, durationSeconds: 2 },
      }),
    ).toThrow('operationManifest 包含未知字段')
    expect(() =>
      parseCloudCommandEnvelope({
        sequence: 3,
        type: 'timeline.add_text',
        postReadAssertions: [
          { path: 'timeline.textCount', operator: 'equals', expected: 1, arbitrary: true },
        ],
        params: { text: 'Keyword', atSeconds: 1, durationSeconds: 2 },
      }),
    ).toThrow('postReadAssertions[0] 包含未知字段')
  })

  it('validates Registry params after mapping targetId', () => {
    const command = parseCloudBridgeCommand({
      sequence: 2,
      type: 'timeline.set_transform',
      targetId: 'c1',
      params: { reset: true },
    })
    const step = describeCloudCommand(command)

    expect(step.tool).toBe('set_transform')
    expect(step.args).toEqual({ items: ['c1'], reset: true })
    expect(
      listCloudCommandCapabilities().find(
        (capability) => capability.type === 'timeline.update_subtitle',
      )?.targetParam,
    ).toBe('item')
    expect(() =>
      parseCloudBridgeCommand({
        sequence: 3,
        type: 'timeline.set_transform',
        params: { reset: true },
      }),
    ).toThrow('命令参数无效')
  })

  it('keeps unrelated editor tools outside both cloud contract versions', () => {
    expect(getEditorTool('seek_to')).toBeDefined()
    expect(getEditorTool('add_transition')).toBeDefined()
    expect(getEditorTool('manage_marker')).toBeDefined()
    for (const type of [
      'timeline.read_history',
      'timeline.seek_to',
      'timeline.add_transition',
      'timeline.add_marker',
      'timeline.restore_snapshot',
    ]) {
      expect(() =>
        parseCloudCommandEnvelope({ sequence: 0, type, params: {} }, 2),
      ).toThrow('本地不支持')
      expect(() =>
        parseCloudCommandEnvelope({ sequence: 0, type, params: {} }, 3),
      ).toThrow('本地不支持')
    }
  })

  it('parses poll tasks and rejects duplicate command sequences', () => {
    expect(
      parseCloudBridgePollResponse({
        deviceId: 'device-1',
        task: {
          id: 'task-1',
          projectId: 'project-1',
          projectName: '演示项目',
          status: 'claimed',
          commandVersion: '2',
          commandContractId: CLOUD_COMMAND_CONTRACT_ID,
          attempt: 2,
          commands: [
            {
              sequence: 0,
              commandId: 'command-1',
              type: 'timeline.read_project',
              params: {},
            },
          ],
        },
      }),
    ).toMatchObject({
      deviceId: 'device-1',
      task: {
        id: 'task-1',
        attempt: 2,
        commands: [{ type: 'timeline.read_project' }],
      },
    })

    expect(() =>
      parseCloudBridgePollResponse({
        deviceId: 'device-1',
        task: {
          id: 'task-1',
          projectId: null,
          projectName: null,
          status: 'claimed',
          commands: [
            { sequence: 0, type: 'timeline.read_project', params: {} },
            { sequence: 0, type: 'timeline.read_project', params: {} },
          ],
        },
      }),
    ).toThrow('重复 sequence')

    expect(() =>
      parseCloudBridgePollResponse({
        deviceId: 'device-1',
        task: {
          id: 'task-1',
          projectId: 'project-1',
          projectName: null,
          status: 'claimed',
          commands: [
            {
              sequence: 0,
              commandId: 'command-1',
              type: 'timeline.read_project',
              params: {},
            },
            {
              sequence: 1,
              commandId: 'command-1',
              type: 'timeline.read_project',
              params: {},
            },
          ],
        },
      }),
    ).toThrow('重复 commandId')
  })

  it('sends the current v3 contract and generated capabilities on every cloud poll', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ deviceId: 'device-1', task: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    globalThis.fetch = fetchMock

    await pollCloudBridge(
      { baseUrl: 'https://api.freecut.example', businessKey: 'business-key' },
      {
        deviceId: 'device-1',
        name: '剪好客户端',
        platform: 'windows',
        clientVersion: '1.0.1',
        commandVersion: CLOUD_COMMAND_VERSION,
        commandContractId: CLOUD_COMMAND_CONTRACT_ID,
        commandCapabilities: listCloudCommandCapabilities(),
        currentProjectId: 'project-1',
        currentProjectName: '演示项目',
        currentSnapshotId: 'local:project-1:snapshot-1',
      },
    )

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(requestInit.body)) as Record<string, unknown>
    expect(body.commandContractId).toBe(CLOUD_COMMAND_CONTRACT_ID)
    expect(body.commandVersion).toBe(CLOUD_COMMAND_VERSION)
    expect(body.commandCapabilities).toEqual(listCloudCommandCapabilities())
  })
})
