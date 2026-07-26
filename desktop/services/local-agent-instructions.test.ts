// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import {
  LOCAL_AGENT_SYSTEM_PROMPT,
  buildLocalAgentSummary,
  buildToolCatalogOutline,
} from './local-agent-instructions'

describe('buildLocalAgentSummary', () => {
  it('always leads with the system prompt', () => {
    expect(buildLocalAgentSummary({})).toContain(LOCAL_AGENT_SYSTEM_PROMPT)
    expect(buildLocalAgentSummary({}).startsWith(LOCAL_AGENT_SYSTEM_PROMPT)).toBe(true)
  })

  it('includes the timeline the renderer built', () => {
    const summary = buildLocalAgentSummary({
      timelineContext: 'Project: 12.0s long at 60fps.\n  c1 video "a.mp4" 0.0–4.0s',
    })

    expect(summary).toContain("Current timeline (as of the user's request):")
    expect(summary).toContain('c1 video "a.mp4" 0.0–4.0s')
  })

  it('says the timeline is unavailable rather than leaving a silent blank', () => {
    // A blank section reads as "empty project" to the model, which then tells the
    // user there is nothing to edit instead of calling a read tool.
    for (const timelineContext of [undefined, '', '   ']) {
      const summary = buildLocalAgentSummary({ timelineContext })
      expect(summary).toContain('Current timeline: unavailable.')
    }
  })

  it('appends the earlier-conversation summary only when there is one', () => {
    expect(buildLocalAgentSummary({ threadSummary: '用户导入了素材。' })).toContain(
      'Earlier in this conversation:\n用户导入了素材。',
    )
    expect(buildLocalAgentSummary({ threadSummary: '   ' })).not.toContain(
      'Earlier in this conversation:',
    )
  })

  it('truncates an oversized timeline without dropping the prompt', () => {
    const summary = buildLocalAgentSummary({
      timelineContext: 'c'.repeat(40_000),
      threadSummary: '摘要',
    })

    expect(summary).toContain(LOCAL_AGENT_SYSTEM_PROMPT)
    expect(summary.length).toBeLessThanOrEqual(20_000)
  })

  it('carries the tool catalog and tells the model what to do with it', () => {
    const summary = buildLocalAgentSummary({
      toolCatalog: buildToolCatalogOutline([
        { name: 'read_timeline', category: 'timeline' },
        { name: 'remove_silence', category: 'discovery' },
      ]),
    })

    expect(summary).toContain('Call tool_describe with an exact name')
    expect(summary).toContain('discovery: remove_silence')
    expect(summary).toContain('timeline: read_timeline')
  })

  it('caps the catalog so a large one cannot crowd out the timeline', () => {
    // The timeline is the grounding the model cannot recover on its own; the
    // catalog is only an index it can fall back to tool_search for.
    const summary = buildLocalAgentSummary({
      toolCatalog: buildToolCatalogOutline(
        Array.from({ length: 4_000 }, (_, index) => ({
          name: `tool_${index}`,
          category: `category_${index % 20}`,
        })),
      ),
      timelineContext: 'c1 video "a.mp4" 0.0–4.0s',
    })

    expect(summary).toContain('c1 video "a.mp4" 0.0–4.0s')
    expect(summary.length).toBeLessThanOrEqual(20_000)
  })
})

describe('buildToolCatalogOutline', () => {
  it('groups names by category, sorted, so the same catalog renders identically', () => {
    const outline = buildToolCatalogOutline([
      { name: 'split', category: 'timeline' },
      { name: 'balance_color', category: 'color' },
      { name: 'read_timeline', category: 'timeline' },
    ])

    // Stable ordering keeps the prompt prefix byte-identical across turns, which
    // is what lets the upstream prompt cache hit instead of re-billing the tree.
    expect(outline).toBe('color: balance_color\ntimeline: read_timeline, split')
  })

  it('renders an empty catalog as an empty string rather than a stray heading', () => {
    expect(buildToolCatalogOutline([])).toBe('')
    expect(buildLocalAgentSummary({ toolCatalog: '' })).not.toContain('Tool catalog')
  })
})
