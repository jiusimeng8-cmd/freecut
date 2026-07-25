import { describe, expect, it } from 'vitest'
import { REQUIRED_TOOL_NAMES } from './capability-manifest'
import { callMcpTool, listMcpTools } from './mcp'
import { getEditorTool, listEditorTools } from './registry'

interface WorkflowToolCase {
  area: string
  name: string
  args: Record<string, unknown>
  expectedProperties: string[]
  readOnly?: boolean
  destructive?: boolean
  handoff?: boolean
  evidence: 'local-state' | 'handoff' | 'external-boundary'
}

const WORKFLOW_TOOL_CASES: readonly WorkflowToolCase[] = [
  {
    area: 'mistake discovery',
    name: 'search_transcript',
    args: { query: 'mistake' },
    expectedProperties: ['query'],
    readOnly: true,
    evidence: 'external-boundary',
  },
  {
    area: 'mistake deletion',
    name: 'delete_items',
    args: { items: ['clip-1'], ripple: true },
    expectedProperties: ['items', 'ripple'],
    destructive: true,
    evidence: 'local-state',
  },
  {
    area: 'filler review',
    name: 'remove_fillers',
    args: { clips: ['c1'] },
    expectedProperties: ['clips'],
    handoff: true,
    evidence: 'handoff',
  },
  {
    area: 'silence removal',
    name: 'remove_silence',
    args: { clips: ['c1'], mode: 'speech', minSilenceMs: 250 },
    expectedProperties: ['clips', 'mode', 'minSilenceMs', 'thresholdDb'],
    destructive: true,
    handoff: false,
    evidence: 'local-state',
  },
  {
    area: 'caption generation',
    name: 'generate_captions',
    args: { clips: ['c1'], replaceExisting: true },
    expectedProperties: ['clips', 'replaceExisting'],
    evidence: 'external-boundary',
  },
  {
    area: 'subtitle item editing',
    name: 'update_subtitle',
    args: { item: 'subtitle-1', text: 'Corrected text', startSeconds: 1, endSeconds: 2 },
    expectedProperties: ['item', 'text', 'startSeconds', 'endSeconds', 'style'],
    evidence: 'local-state',
  },
  {
    area: 'subtitle cue editing',
    name: 'edit_subtitle_cues',
    args: {
      item: 'subtitle-1',
      operation: 'update',
      cueId: 'cue-1',
      patch: { text: 'Corrected text' },
    },
    expectedProperties: ['item', 'operation', 'cueId', 'patch'],
    evidence: 'local-state',
  },
  {
    area: 'subtitle styling',
    name: 'style_subtitles',
    args: { items: ['subtitle-1'], style: { fontSize: 48, color: '#ffffff' } },
    expectedProperties: ['items', 'style'],
    evidence: 'local-state',
  },
  {
    area: 'B-roll placement',
    name: 'place_media',
    args: { mediaIds: ['media-broll'], atSeconds: 3, layout: 'cover' },
    expectedProperties: ['mediaIds', 'atSeconds', 'trackId', 'layout'],
    evidence: 'external-boundary',
  },
  {
    area: 'source range placement',
    name: 'source_edit',
    args: {
      operation: 'insert',
      mediaId: 'media-broll',
      sourceInSeconds: 1,
      sourceOutSeconds: 3,
      atSeconds: 3,
      patchVideo: true,
      patchAudio: false,
    },
    expectedProperties: [
      'operation',
      'mediaId',
      'sourceInSeconds',
      'sourceOutSeconds',
      'atSeconds',
      'patchVideo',
      'patchAudio',
      'videoTrackId',
      'audioTrackId',
    ],
    evidence: 'external-boundary',
  },
  {
    area: 'keyword text',
    name: 'add_text',
    args: { text: 'Keyword', atSeconds: 2, durationSeconds: 1.5, role: 'title' },
    expectedProperties: ['text', 'atSeconds', 'durationSeconds', 'trackId', 'role', 'style'],
    evidence: 'local-state',
  },
  {
    area: 'static zoom',
    name: 'set_transform',
    args: { items: ['video-1'], transform: { width: 2304, height: 1296 } },
    expectedProperties: ['items', 'transform', 'crop', 'reset'],
    evidence: 'local-state',
  },
  {
    area: 'animated zoom',
    name: 'set_keyframes',
    args: {
      operations: [
        {
          operation: 'add',
          item: 'video-1',
          property: 'transform.scale',
          frame: 30,
          value: 1.1,
          easing: 'ease-out',
        },
      ],
    },
    expectedProperties: ['operations'],
    evidence: 'local-state',
  },
  {
    area: 'linear clip volume',
    name: 'set_volume',
    args: { clips: ['c1'], volume: 0.8 },
    expectedProperties: ['clips', 'volume'],
    evidence: 'local-state',
  },
  {
    area: 'voice gain and fades',
    name: 'set_audio',
    args: { items: ['audio-1'], volumeDb: -3, fadeInSeconds: 0.25, fadeOutSeconds: 0.25 },
    expectedProperties: ['items', 'volumeDb', 'fadeInSeconds', 'fadeOutSeconds', 'eq'],
    evidence: 'local-state',
  },
  {
    area: 'project save',
    name: 'save_project',
    args: { projectId: 'project-1' },
    expectedProperties: ['projectId'],
    evidence: 'external-boundary',
  },
  {
    area: 'MP4 preflight',
    name: 'check_export',
    args: {
      mode: 'video',
      codec: 'h264',
      videoContainer: 'mp4',
      subtitleMode: 'burn',
      quality: 'high',
    },
    expectedProperties: [
      'mode',
      'codec',
      'videoContainer',
      'subtitleMode',
      'quality',
      'fileName',
    ],
    readOnly: true,
    evidence: 'external-boundary',
  },
  {
    area: 'MP4 export',
    name: 'enqueue_export',
    args: {
      mode: 'video',
      codec: 'h264',
      videoContainer: 'mp4',
      subtitleMode: 'burn',
      quality: 'high',
      fileName: 'final.mp4',
    },
    expectedProperties: [
      'mode',
      'codec',
      'videoContainer',
      'subtitleMode',
      'quality',
      'fileName',
    ],
    evidence: 'external-boundary',
  },
  {
    area: 'MP4 artifact readback',
    name: 'get_export_artifact',
    args: { projectId: 'project-1', fileName: 'final.mp4' },
    expectedProperties: ['projectId', 'jobId', 'fileName'],
    readOnly: true,
    evidence: 'external-boundary',
  },
  {
    area: 'SRT export',
    name: 'export_subtitles',
    args: { sequenceId: null, fileName: 'captions.srt', rangeMode: 'whole' },
    expectedProperties: [
      'sequenceId',
      'fileName',
      'rangeMode',
      'startSeconds',
      'endSeconds',
    ],
    evidence: 'external-boundary',
  },
]

describe('editor Tool Registry smoke', () => {
  it('freezes 170 unique tools against the capability manifest and MCP list', () => {
    const tools = listEditorTools()
    const names = tools.map((tool) => tool.name)
    const descriptors = listMcpTools()

    expect(tools).toHaveLength(170)
    expect(REQUIRED_TOOL_NAMES).toHaveLength(170)
    expect(descriptors).toHaveLength(170)
    expect(new Set(names).size).toBe(170)
    expect(new Set(REQUIRED_TOOL_NAMES).size).toBe(170)
    expect([...names].sort()).toEqual([...REQUIRED_TOOL_NAMES].sort())
    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([...names].sort())
  })

  it('publishes serializable object JSON Schemas with valid required keys', () => {
    for (const tool of listEditorTools()) {
      const schema = tool.inputSchema
      const required = schema.required ?? []
      const propertyNames = Object.keys(schema.properties)

      expect(tool.name, tool.name).toMatch(/^[a-z0-9_]+$/)
      expect(tool.title.trim(), tool.name).not.toBe('')
      expect(tool.description.trim(), tool.name).not.toBe('')
      expect(schema.type, tool.name).toBe('object')
      expect(schema.properties, tool.name).not.toBeNull()
      expect(Array.isArray(schema.properties), tool.name).toBe(false)
      expect(schema.additionalProperties, tool.name).toBe(false)
      expect(new Set(required).size, tool.name).toBe(required.length)
      for (const key of required) {
        expect(propertyNames, `${tool.name}.${key}`).toContain(key)
      }
      expect(JSON.parse(JSON.stringify(schema)), tool.name).toEqual(schema)
    }
  })

  it('keeps every validate function total and every MCP name callable without execution', async () => {
    for (const tool of listEditorTools()) {
      for (const input of [undefined, null, {}, [], '__invalid_registry_smoke__']) {
        expect(() => tool.validate(input), `${tool.name} validate`).not.toThrow()
        const validation = tool.validate(input)
        expect(typeof validation.ok, tool.name).toBe('boolean')
        if (validation.ok) {
          expect(validation.value, tool.name).toBeTypeOf('object')
          expect(Array.isArray(validation.value), tool.name).toBe(false)
        } else {
          expect(validation.error.trim(), tool.name).not.toBe('')
        }
      }
    }

    const calls = await Promise.all(
      listEditorTools().map((tool) => callMcpTool(tool.name, '__invalid_registry_smoke__')),
    )
    for (const [index, result] of calls.entries()) {
      expect(result.isError, listEditorTools()[index]!.name).toBe(true)
      expect(result.content[0]?.text, listEditorTools()[index]!.name).toContain(
        'Invalid arguments',
      )
    }
  })

  it.each(WORKFLOW_TOOL_CASES)(
    '$area uses a structured, Registry-valid $name call',
    ({ name, args, expectedProperties, readOnly, destructive, handoff }) => {
      const tool = getEditorTool(name)
      expect(tool, name).toBeDefined()
      expect(Object.keys(tool!.inputSchema.properties), name).toEqual(
        expect.arrayContaining(expectedProperties),
      )
      if (readOnly !== undefined) expect(tool!.readOnly, name).toBe(readOnly)
      if (destructive !== undefined) expect(tool!.destructive, name).toBe(destructive)
      if (handoff !== undefined) expect(tool!.handoff, name).toBe(handoff)

      const validation = tool!.validate(args)
      expect(validation.ok, name).toBe(true)
      if (!validation.ok) return
      expect(tool!.summarize(validation.value).trim(), name).not.toBe('')
    },
  )

  it('makes handoff and external-boundary evidence explicit', () => {
    expect(
      WORKFLOW_TOOL_CASES.filter((entry) => entry.evidence === 'handoff').map(
        (entry) => entry.name,
      ),
    ).toEqual(['remove_fillers'])
    expect(
      WORKFLOW_TOOL_CASES.filter((entry) => entry.evidence === 'external-boundary').map(
        (entry) => entry.name,
      ),
    ).toEqual([
      'search_transcript',
      'generate_captions',
      'place_media',
      'source_edit',
      'save_project',
      'check_export',
      'enqueue_export',
      'get_export_artifact',
      'export_subtitles',
    ])
  })
})
