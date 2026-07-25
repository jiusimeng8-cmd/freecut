import { describe, expect, it } from 'vitest'
import {
  describeMcpTool,
  listMcpToolCategories,
  listMcpTools,
  searchMcpTools,
  callMcpTool,
  normalizeToolResult,
} from './mcp'
import { listEditorTools } from './registry'
import { REQUIRED_TOOL_NAMES } from './capability-manifest'

describe('MCP tool mapping', () => {
  it('exposes every registry tool as an MCP descriptor with a JSON-Schema input', () => {
    const descriptors = listMcpTools()
    expect(descriptors.length).toBe(listEditorTools().length)

    for (const descriptor of descriptors) {
      expect(descriptor.name).toBeTruthy()
      expect(descriptor.description).toBeTruthy()
      expect(descriptor.inputSchema.type).toBe('object')
      expect(descriptor._meta['freecut/category'].id).toBeTruthy()
      expect(descriptor._meta['freecut/category'].title).toBeTruthy()
      expect(descriptor._meta['freecut/category'].group).toBeTruthy()
      expect(descriptor.annotations.title).toBeTruthy()
      expect(typeof descriptor.annotations.readOnlyHint).toBe('boolean')
      expect(typeof descriptor.annotations.destructiveHint).toBe('boolean')
      expect(typeof descriptor.annotations.requiresProject).toBe('boolean')
      expect(typeof descriptor.annotations.handoffRequired).toBe('boolean')
    }
  })

  it('publishes a complete categorized MCP catalog without duplicate tools', () => {
    const categories = listMcpToolCategories()
    const categorizedNames = categories.flatMap((category) => category.tools)
    const descriptors = listMcpTools()

    expect(categories.map((category) => category.id)).toEqual(
      expect.arrayContaining(['appRuntime', 'diagnostics', 'timeline', 'color', 'export']),
    )
    expect(new Set(categorizedNames).size).toBe(categorizedNames.length)
    expect([...categorizedNames].sort()).toEqual(
      descriptors.map((descriptor) => descriptor.name).sort(),
    )
    expect(
      descriptors.find((descriptor) => descriptor.name === 'balance_color')?._meta[
        'freecut/category'
      ],
    ).toMatchObject({ id: 'color', group: 'creative' })
    expect(
      descriptors.find((descriptor) => descriptor.name === 'read_diagnostics')?._meta[
        'freecut/category'
      ],
    ).toMatchObject({ id: 'diagnostics', group: 'diagnostics' })
  })

  it('matches the fixed FreeCut platform capability manifest with unique names', () => {
    const registered = listEditorTools().map((tool) => tool.name)
    expect(new Set(REQUIRED_TOOL_NAMES).size).toBe(REQUIRED_TOOL_NAMES.length)
    expect(new Set(registered).size).toBe(registered.length)
    expect([...registered].sort()).toEqual([...REQUIRED_TOOL_NAMES].sort())
  })

  it('flags destructive vs read-only tools correctly', () => {
    const byName = new Map(listMcpTools().map((tool) => [tool.name, tool]))
    expect(byName.get('find_clips')?.annotations.readOnlyHint).toBe(true)
    expect(byName.get('import_local_media')?.annotations.readOnlyHint).toBe(false)
    expect(byName.has('generate_captions')).toBe(true)
    expect(byName.get('delete_clips')?.annotations.destructiveHint).toBe(true)
    expect(byName.get('find_clips')?.annotations.destructiveHint).toBe(false)
    expect(byName.get('find_clips')?.annotations.requiresProject).toBe(true)
    expect(byName.get('list_projects')?.annotations.requiresProject).toBe(false)
    expect(byName.get('manage_bento_preset')?.annotations.destructiveHint).toBe(true)
  })

  it('finds matching MCP descriptors without executing tools', () => {
    const results = searchMcpTools('color grading')

    expect(results.map((tool) => tool.name)).toContain('balance_color')
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _meta: expect.objectContaining({
            'freecut/category': expect.objectContaining({ id: 'color' }),
          }),
        }),
      ]),
    )
  })

  it('filters discovery results by category and applies an explicit limit', () => {
    const results = searchMcpTools('', { category: 'timeline', limit: 2 })

    expect(results).toHaveLength(2)
    expect(results.every((tool) => tool._meta['freecut/category'].id === 'timeline')).toBe(true)
  })

  it('returns catalog results in a stable deterministic order', () => {
    const first = searchMcpTools('', { category: 'timeline', limit: 10 })
    const second = searchMcpTools('', { category: 'timeline', limit: 10 })

    expect(first.map((tool) => tool.name)).toEqual(second.map((tool) => tool.name))
    expect(first.map((tool) => tool.name)).toEqual([...first.map((tool) => tool.name)].sort())
  })

  it('describes one known tool and returns undefined for an unknown name', () => {
    expect(describeMcpTool('balance_color')).toMatchObject({
      name: 'balance_color',
      _meta: { 'freecut/category': { id: 'color', group: 'creative' } },
      annotations: {
        readOnlyHint: false,
        requiresProject: true,
      },
    })
    expect(describeMcpTool('does_not_exist')).toBeUndefined()
  })

  it('exposes structured source edit inputs', () => {
    const sourceEdit = listMcpTools().find((tool) => tool.name === 'source_edit')
    expect(sourceEdit?.inputSchema.properties).toMatchObject({
      operation: { type: 'string' },
      mediaId: { type: 'string' },
      sourceInSeconds: { type: 'number' },
      sourceOutSeconds: { type: 'number' },
      atSeconds: { type: 'number' },
      patchVideo: { type: 'boolean' },
      patchAudio: { type: 'boolean' },
      videoTrackId: { type: 'string' },
      audioTrackId: { type: 'string' },
    })
  })

  it('returns a structured error for an unknown tool', async () => {
    const result = await callMcpTool('does_not_exist', {}, { requestId: 'request-missing' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Unknown tool')
    expect(result.structuredContent).toMatchObject({
      requestId: 'request-missing',
      operationId: 'request-missing',
      changed: false,
      projectRevision: null,
      changeSummary: null,
      finalStatus: 'failed',
      error: { code: 'TOOL_NOT_FOUND' },
      warnings: [],
    })
  })

  it('returns a structured error for invalid arguments', async () => {
    // set_speed requires a numeric `speed`; omitting it must fail validation
    // before any execution side effects.
    const result = await callMcpTool('set_speed', {}, { requestId: 'request-invalid' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Invalid arguments')
    expect(result.structuredContent).toMatchObject({
      requestId: 'request-invalid',
      operationId: 'request-invalid',
      changed: false,
      finalStatus: 'failed',
      error: { code: 'INVALID_ARGUMENTS' },
      warnings: [],
    })
  })

  it('emits the complete normalized ToolResult receipt as structured content', async () => {
    const result = await callMcpTool(
      'read_history',
      {},
      { requestId: 'request-read', projectRevision: 42 },
    )
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toMatchObject({
      ok: true,
      message: expect.any(String),
      requestId: 'request-read',
      operationId: 'request-read',
      changed: false,
      projectRevision: 42,
      changeSummary: null,
      finalStatus: 'succeeded',
      error: null,
      warnings: [],
    })
  })

  it('preserves explicit operation, revision, change, status, error, and warning fields', () => {
    expect(
      normalizeToolResult(
        {
          ok: false,
          message: 'Execution outcome is uncertain.',
          requestId: 'inner-request',
          operationId: 'operation-1',
          changed: true,
          projectRevision: 'revision-2',
          changeSummary: 'Updated one timeline item.',
          finalStatus: 'uncertain',
          error: { code: 'RESULT_UNCERTAIN', message: 'Execution outcome is uncertain.' },
          warnings: [{ code: 'VERIFY_PROJECT', message: 'Read the project again.' }],
        },
        { requestId: 'bridge-request', projectRevision: 'revision-1' },
      ),
    ).toMatchObject({
      requestId: 'bridge-request',
      operationId: 'operation-1',
      changed: true,
      projectRevision: 'revision-2',
      changeSummary: 'Updated one timeline item.',
      finalStatus: 'uncertain',
      error: { code: 'RESULT_UNCERTAIN' },
      warnings: [{ code: 'VERIFY_PROJECT' }],
    })
  })

  it('keeps manifest flags, phase receipts, and reconciliation additive to v2 receipts', () => {
    const normalized = normalizeToolResult(
      {
        ok: true,
        message: 'Applied.',
        changed: true,
        operationManifest: {
          contractId: 'freecut.timeline.commands.v2',
          commandType: 'timeline.split',
          tool: 'split',
          impactFlags: ['semantic', 'timing', 'caption', 'audio'],
          requiresPostReadback: true,
        },
        phaseReceipts: [
          { phase: 'transport', status: 'succeeded' },
          { phase: 'toolAck', status: 'succeeded' },
        ],
        reconciliationStatus: 'VERIFIED_APPLIED',
        reconciliation: {
          observedAt: '2026-07-22T00:00:00.000Z',
          method: 'renderer-composite-readback',
          status: 'applied',
          retryAttempted: false,
          newTaskCreated: false,
          newCommandCreated: false,
        },
      },
      { requestId: 'request-1' },
    )

    expect(normalized).toMatchObject({
      requestId: 'request-1',
      finalStatus: 'succeeded',
      impactFlags: ['semantic', 'timing', 'caption', 'audio'],
      reconciliationStatus: 'VERIFIED_APPLIED',
      reconciliation: { status: 'applied' },
      phaseReceipts: [
        { phase: 'transport', status: 'succeeded' },
        { phase: 'toolAck', status: 'succeeded' },
      ],
    })
  })
})
