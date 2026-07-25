import { z } from 'zod'
import { useProjectStore } from '@/features/editor/deps/projects'
import {
  executeTimelineCommand,
  useItemsStore,
  useTimelineSettingsStore,
  useTimelineStore,
} from '@/features/editor/deps/timeline-contract'
import {
  applyTextStylePresetToItem,
  TEXT_STYLE_PRESETS,
} from '@/shared/typography/text-style-presets'
import { TEXT_STYLE_PRESET_IDS } from '@/shared/typography/text-style-preset-ids'
import { buildTextItemLabelFromText } from '@/shared/utils/text-item-spans'
import type {
  SubtitleSegmentCue,
  SubtitleSegmentItem,
  TextItem,
  TextSpan,
  TimelineItem,
  TimelineTranscriptCaptionCue,
  TimelineTranscriptCaptions,
} from '@/types/timeline'
import {
  definePlatformTool,
  objectSchema,
  resolveItemHandles,
} from './shared'

const textStyleSchema = z.object({
  fontSize: z.number().positive().optional(),
  fontFamily: z.string().min(1).optional(),
  fontWeight: z.enum(['normal', 'medium', 'semibold', 'bold']).optional(),
  fontStyle: z.enum(['normal', 'italic']).optional(),
  underline: z.boolean().optional(),
  color: z.string().min(1).optional(),
  letterSpacing: z.number().optional(),
  backgroundColor: z.string().optional(),
  backgroundRadius: z.number().min(0).optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).optional(),
  lineHeight: z.number().positive().optional(),
  textPadding: z.number().min(0).optional(),
  textShadow: z
    .object({
      offsetX: z.number(),
      offsetY: z.number(),
      blur: z.number().min(0),
      color: z.string(),
    })
    .optional(),
  stroke: z
    .object({
      width: z.number().min(0),
      color: z.string(),
    })
    .optional(),
})

const transformSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  anchorX: z.number().optional(),
  anchorY: z.number().optional(),
  rotation: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
})

const transcriptStyleSchema = textStyleSchema.extend({
  transform: transformSchema.optional(),
})

const cueSchema = z
  .object({
    id: z.string().min(1).optional(),
    startSeconds: z.number().min(0),
    endSeconds: z.number().min(0),
    text: z.string(),
  })
  .refine((cue) => cue.endSeconds > cue.startSeconds, {
    message: 'endSeconds must be greater than startSeconds.',
  })

const cuePatchSchema = z.object({
  startSeconds: z.number().min(0).optional(),
  endSeconds: z.number().min(0).optional(),
  text: z.string().optional(),
})

const textSpanSchema = z.object({
  text: z.string(),
  fontSize: z.number().positive().optional(),
  fontFamily: z.string().min(1).optional(),
  fontWeight: z.enum(['normal', 'medium', 'semibold', 'bold']).optional(),
  fontStyle: z.enum(['normal', 'italic']).optional(),
  underline: z.boolean().optional(),
  color: z.string().min(1).optional(),
  letterSpacing: z.number().optional(),
})

function getSubtitle(handle: string): SubtitleSegmentItem {
  const [item] = resolveItemHandles([handle], {
    allowSelection: false,
    itemTypes: ['subtitle'],
  })
  if (!item || item.type !== 'subtitle') {
    throw new Error(`Subtitle segment not found: ${handle}`)
  }
  return item
}

function cueListEqual(
  left: Array<SubtitleSegmentCue | TimelineTranscriptCaptionCue>,
  right: Array<SubtitleSegmentCue | TimelineTranscriptCaptionCue>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sortCues<T extends SubtitleSegmentCue | TimelineTranscriptCaptionCue>(cues: T[]): T[] {
  return [...cues].sort(
    (left, right) =>
      left.startSeconds - right.startSeconds ||
      left.endSeconds - right.endSeconds ||
      left.id.localeCompare(right.id),
  )
}

function assertUniqueCueIds(cues: Array<{ id: string }>): void {
  if (new Set(cues.map((cue) => cue.id)).size !== cues.length) {
    throw new Error('Cue ids must be unique.')
  }
}

function assertSubtitleCueBounds(cues: SubtitleSegmentCue[], durationSeconds: number): void {
  assertUniqueCueIds(cues)
  for (const cue of cues) {
    if (cue.startSeconds < 0 || cue.endSeconds <= cue.startSeconds) {
      throw new Error(`Invalid cue timing: ${cue.id}`)
    }
    if (cue.endSeconds > durationSeconds) {
      throw new Error(`Cue ${cue.id} exceeds the subtitle segment duration.`)
    }
  }
}

const editSubtitleCues = definePlatformTool({
  name: 'edit_subtitle_cues',
  title: 'Edit subtitle cues',
  description:
    'Add, update, remove, split, or merge segment-relative cues inside one SubtitleSegmentItem.',
  inputSchema: objectSchema(
    {
      item: { type: 'string' },
      operation: { type: 'string', enum: ['add', 'update', 'remove', 'split', 'merge'] },
      cueId: { type: 'string' },
      cueIds: { type: 'array', items: { type: 'string' } },
      cue: { type: 'object' },
      patch: { type: 'object' },
      splitAtSeconds: { type: 'number', minimum: 0 },
      leftText: { type: 'string' },
      rightText: { type: 'string' },
      text: { type: 'string' },
    },
    ['item', 'operation'],
  ),
  schema: z.object({
    item: z.string().min(1),
    operation: z.enum(['add', 'update', 'remove', 'split', 'merge']),
    cueId: z.string().min(1).optional(),
    cueIds: z.array(z.string().min(1)).min(2).optional(),
    cue: cueSchema.optional(),
    patch: cuePatchSchema.optional(),
    splitAtSeconds: z.number().min(0).optional(),
    leftText: z.string().optional(),
    rightText: z.string().optional(),
    text: z.string().optional(),
  }),
  summarize: ({ operation }) => `${operation} subtitle cue`,
  execute: ({
    item: handle,
    operation,
    cueId,
    cueIds,
    cue,
    patch,
    splitAtSeconds,
    leftText,
    rightText,
    text,
  }) => {
    const subtitle = getSubtitle(handle)
    let nextCues = [...subtitle.cues]

    if (operation === 'add') {
      if (!cue) throw new Error('cue is required for add.')
      nextCues.push({ ...cue, id: cue.id ?? crypto.randomUUID() })
    } else if (operation === 'update') {
      if (!cueId || !patch || Object.values(patch).every((value) => value === undefined)) {
        throw new Error('cueId and a non-empty patch are required for update.')
      }
      const current = nextCues.find((candidate) => candidate.id === cueId)
      if (!current) throw new Error(`Subtitle cue not found: ${cueId}`)
      nextCues = nextCues.map((candidate) =>
        candidate.id === cueId ? { ...candidate, ...patch } : candidate,
      )
    } else if (operation === 'remove') {
      if (!cueId) throw new Error('cueId is required for remove.')
      if (!nextCues.some((candidate) => candidate.id === cueId)) {
        throw new Error(`Subtitle cue not found: ${cueId}`)
      }
      nextCues = nextCues.filter((candidate) => candidate.id !== cueId)
    } else if (operation === 'split') {
      if (!cueId || splitAtSeconds === undefined || leftText === undefined || rightText === undefined) {
        throw new Error('cueId, splitAtSeconds, leftText, and rightText are required for split.')
      }
      const current = nextCues.find((candidate) => candidate.id === cueId)
      if (!current) throw new Error(`Subtitle cue not found: ${cueId}`)
      if (splitAtSeconds <= current.startSeconds || splitAtSeconds >= current.endSeconds) {
        throw new Error('splitAtSeconds must fall inside the cue.')
      }
      nextCues = nextCues.flatMap((candidate) =>
        candidate.id === cueId
          ? [
              { ...candidate, endSeconds: splitAtSeconds, text: leftText },
              {
                id: crypto.randomUUID(),
                startSeconds: splitAtSeconds,
                endSeconds: candidate.endSeconds,
                text: rightText,
              },
            ]
          : [candidate],
      )
    } else {
      if (!cueIds) throw new Error('cueIds are required for merge.')
      const selectedIds = new Set(cueIds)
      const selected = subtitle.cues
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ candidate }) => selectedIds.has(candidate.id))
      if (selected.length !== selectedIds.size) {
        throw new Error('One or more merge cues were not found.')
      }
      for (let index = 1; index < selected.length; index += 1) {
        if (selected[index]!.index !== selected[index - 1]!.index + 1) {
          throw new Error('Merge cues must be contiguous in the subtitle cue order.')
        }
      }
      const first = selected[0]!.candidate
      const last = selected[selected.length - 1]!.candidate
      const merged: SubtitleSegmentCue = {
        ...first,
        endSeconds: last.endSeconds,
        text: text ?? selected.map(({ candidate }) => candidate.text.trim()).join(' ').trim(),
      }
      nextCues = subtitle.cues.flatMap((candidate) => {
        if (candidate.id === first.id) return [merged]
        return selectedIds.has(candidate.id) ? [] : [candidate]
      })
    }

    nextCues = sortCues(nextCues)
    assertSubtitleCueBounds(
      nextCues,
      subtitle.durationInFrames / useTimelineSettingsStore.getState().fps,
    )
    const changed = !cueListEqual(subtitle.cues, nextCues)
    if (changed) {
      useTimelineStore.getState().updateItem(subtitle.id, { cues: nextCues })
    }
    return {
      ok: true,
      message: changed ? `Updated subtitle cues for ${subtitle.id}.` : 'Subtitle cues were unchanged.',
      data: { itemId: subtitle.id, cues: nextCues },
      changed,
    }
  },
})

function transcriptContentEqual(
  left: TimelineTranscriptCaptions | undefined,
  right: TimelineTranscriptCaptions | undefined,
): boolean {
  if (!left || !right) return left === right
  return (
    left.type === right.type &&
    left.mediaId === right.mediaId &&
    left.enabled === right.enabled &&
    JSON.stringify(left.cues) === JSON.stringify(right.cues) &&
    JSON.stringify(left.style) === JSON.stringify(right.style)
  )
}

const manageTranscriptCaptions = definePlatformTool({
  name: 'manage_transcript_captions',
  title: 'Manage transcript captions',
  description:
    'Manage source-relative transcript captions stored on video/audio clips, including visibility, cues, and style.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      operation: {
        type: 'string',
        enum: [
          'set_enabled',
          'replace_cues',
          'add_cue',
          'update_cue',
          'remove_cue',
          'set_style',
          'clear_style',
          'clear',
        ],
      },
      enabled: { type: 'boolean' },
      cues: { type: 'array', items: { type: 'object' } },
      cue: { type: 'object' },
      cueId: { type: 'string' },
      patch: { type: 'object' },
      style: { type: 'object' },
    },
    ['items', 'operation'],
  ),
  schema: z.object({
    items: z.array(z.string().min(1)).min(1),
    operation: z.enum([
      'set_enabled',
      'replace_cues',
      'add_cue',
      'update_cue',
      'remove_cue',
      'set_style',
      'clear_style',
      'clear',
    ]),
    enabled: z.boolean().optional(),
    cues: z.array(cueSchema).optional(),
    cue: cueSchema.optional(),
    cueId: z.string().min(1).optional(),
    patch: cuePatchSchema.optional(),
    style: transcriptStyleSchema.optional(),
  }),
  summarize: ({ operation, items }) =>
    `${operation} on ${items.length} transcript caption item${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles, operation, enabled, cues, cue, cueId, patch, style }) => {
    const items = resolveItemHandles(handles, {
      allowSelection: false,
      itemTypes: ['video', 'audio'],
    })
    if (items.length === 0) throw new Error('No video/audio items were found.')

    const replacementCues =
      operation === 'replace_cues'
        ? sortCues(
            (cues ?? []).map((candidate) => ({
              ...candidate,
              id: candidate.id ?? crypto.randomUUID(),
            })),
          )
        : undefined
    if (replacementCues) assertUniqueCueIds(replacementCues)
    const addedCue =
      operation === 'add_cue' && cue
        ? { ...cue, id: cue.id ?? crypto.randomUUID() }
        : undefined

    const updates: Array<{
      item: TimelineItem
      captions: TimelineTranscriptCaptions | undefined
    }> = []
    for (const item of items) {
      const current = item.transcriptCaptions
      if (operation === 'clear') {
        if (current) updates.push({ item, captions: undefined })
        continue
      }
      if (!current && !item.mediaId) {
        throw new Error(`Item ${item.id} has no media id for transcript captions.`)
      }
      const base: TimelineTranscriptCaptions = current ?? {
        type: 'transcript',
        mediaId: item.mediaId!,
        enabled: true,
        updatedAt: Date.now(),
        cues: [],
      }
      let next: TimelineTranscriptCaptions

      if (operation === 'set_enabled') {
        if (enabled === undefined) throw new Error('enabled is required for set_enabled.')
        next = { ...base, enabled }
      } else if (operation === 'replace_cues') {
        if (!replacementCues) throw new Error('cues are required for replace_cues.')
        next = { ...base, cues: replacementCues }
      } else if (operation === 'add_cue') {
        if (!addedCue) throw new Error('cue is required for add_cue.')
        if (base.cues.some((candidate) => candidate.id === addedCue.id)) {
          throw new Error(`Transcript cue already exists: ${addedCue.id}`)
        }
        next = { ...base, cues: sortCues([...base.cues, addedCue]) }
      } else if (operation === 'update_cue') {
        if (!cueId || !patch || Object.values(patch).every((value) => value === undefined)) {
          throw new Error('cueId and a non-empty patch are required for update_cue.')
        }
        const target = base.cues.find((candidate) => candidate.id === cueId)
        if (!target) throw new Error(`Transcript cue not found: ${cueId}`)
        const updatedCue = { ...target, ...patch }
        if (updatedCue.endSeconds <= updatedCue.startSeconds) {
          throw new Error('endSeconds must be greater than startSeconds.')
        }
        next = {
          ...base,
          cues: sortCues(
            base.cues.map((candidate) => (candidate.id === cueId ? updatedCue : candidate)),
          ),
        }
      } else if (operation === 'remove_cue') {
        if (!cueId) throw new Error('cueId is required for remove_cue.')
        if (!base.cues.some((candidate) => candidate.id === cueId)) {
          throw new Error(`Transcript cue not found: ${cueId}`)
        }
        next = { ...base, cues: base.cues.filter((candidate) => candidate.id !== cueId) }
      } else if (operation === 'set_style') {
        if (!style) throw new Error('style is required for set_style.')
        next = { ...base, style: { ...(base.style ?? {}), ...style } }
      } else {
        next = { ...base, style: undefined }
      }

      assertUniqueCueIds(next.cues)
      if (!transcriptContentEqual(current, next)) {
        updates.push({ item, captions: { ...next, updatedAt: Date.now() } })
      }
    }

    if (updates.length > 0) {
      executeTimelineCommand(
        'AGENT_MANAGE_TRANSCRIPT_CAPTIONS',
        () => {
          const store = useItemsStore.getState()
          for (const update of updates) {
            store._updateItem(update.item.id, {
              transcriptCaptions: update.captions,
            } as Partial<TimelineItem>)
          }
          useTimelineSettingsStore.getState().markDirty()
        },
        { itemIds: updates.map((update) => update.item.id), operation },
      )
    }
    return {
      ok: true,
      message:
        updates.length > 0
          ? `Updated transcript captions on ${updates.length} item${updates.length === 1 ? '' : 's'}.`
          : 'Transcript captions were unchanged.',
      data: { itemIds: updates.map((update) => update.item.id), operation },
      changed: updates.length > 0,
    }
  },
})

function hasItemChanges(item: TimelineItem, updates: Partial<TimelineItem>): boolean {
  return Object.entries(updates).some(
    ([key, value]) =>
      JSON.stringify((item as unknown as Record<string, unknown>)[key]) !== JSON.stringify(value),
  )
}

const editText = definePlatformTool({
  name: 'edit_text',
  title: 'Edit text layer',
  description:
    'Edit plain or rich text content, absolute timeline timing, caption role, and typography on a TextItem.',
  inputSchema: objectSchema(
    {
      item: { type: 'string' },
      text: { type: 'string' },
      textSpans: { type: 'array', items: { type: 'object' } },
      startSeconds: { type: 'number', minimum: 0 },
      endSeconds: { type: 'number', minimum: 0 },
      role: { type: 'string', enum: ['title', 'caption'] },
      style: { type: 'object' },
    },
    ['item'],
  ),
  schema: z.object({
    item: z.string().min(1),
    text: z.string().optional(),
    textSpans: z.array(textSpanSchema).min(1).optional(),
    startSeconds: z.number().min(0).optional(),
    endSeconds: z.number().min(0).optional(),
    role: z.enum(['title', 'caption']).optional(),
    style: textStyleSchema.optional(),
  }),
  summarize: () => 'Edit text layer',
  execute: ({ item: handle, text, textSpans, startSeconds, endSeconds, role, style }) => {
    if (text !== undefined && textSpans !== undefined) {
      throw new Error('Provide either text or textSpans, not both.')
    }
    const [item] = resolveItemHandles([handle], {
      allowSelection: false,
      itemTypes: ['text'],
    })
    if (!item || item.type !== 'text') throw new Error(`Text item not found: ${handle}`)
    const fps = useTimelineSettingsStore.getState().fps
    const currentStart = item.from / fps
    const currentEnd = (item.from + item.durationInFrames) / fps
    const nextStart = startSeconds ?? currentStart
    const nextEnd = endSeconds ?? currentEnd
    if (nextEnd <= nextStart) throw new Error('endSeconds must be greater than startSeconds.')

    const updates: Partial<TextItem> = {
      ...(startSeconds !== undefined ? { from: Math.round(nextStart * fps) } : {}),
      ...(startSeconds !== undefined || endSeconds !== undefined
        ? { durationInFrames: Math.max(1, Math.round((nextEnd - nextStart) * fps)) }
        : {}),
      ...(style ?? {}),
      ...(role !== undefined ? { textRole: role === 'caption' ? ('caption' as const) : undefined } : {}),
    }
    if (text !== undefined) {
      updates.text = text
      updates.textSpans = undefined
      updates.label = buildTextItemLabelFromText(text)
    } else if (textSpans !== undefined) {
      const spans = textSpans as TextSpan[]
      const richText = spans.map((span) => span.text).join('\n')
      updates.text = richText
      updates.textSpans = spans
      updates.label = buildTextItemLabelFromText(richText)
    }

    if (Object.keys(updates).length === 0) {
      throw new Error('At least one text, timing, role, or style field is required.')
    }
    const changed = hasItemChanges(item, updates as Partial<TimelineItem>)
    if (changed) {
      useTimelineStore.getState().updateItem(item.id, updates as Partial<TimelineItem>)
    }
    return {
      ok: true,
      message: changed ? `Updated text item ${item.id}.` : 'Text item was unchanged.',
      data: useTimelineStore.getState().items.find((candidate) => candidate.id === item.id),
      changed,
    }
  },
})

const listTextStylePresets = definePlatformTool({
  name: 'list_text_style_presets',
  title: 'List text style presets',
  description: 'List built-in editable FreeCut text style presets.',
  inputSchema: objectSchema({}),
  readOnly: true,
  schema: z.object({}),
  summarize: () => 'List text style presets',
  execute: () => ({
    ok: true,
    message: `Found ${TEXT_STYLE_PRESETS.length} text style presets.`,
    data: TEXT_STYLE_PRESETS,
  }),
})

const applyTextStylePreset = definePlatformTool({
  name: 'apply_text_style_preset',
  title: 'Apply text style preset',
  description:
    'Apply one built-in text style preset to multiple text layers while preserving their existing words.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      presetId: { type: 'string', enum: TEXT_STYLE_PRESET_IDS },
      styleScale: { type: 'number', minimum: 0.1 },
    },
    ['items', 'presetId'],
  ),
  schema: z.object({
    items: z.array(z.string().min(1)).min(1),
    presetId: z.enum(TEXT_STYLE_PRESET_IDS),
    styleScale: z.number().min(0.1).max(10).optional(),
  }),
  summarize: ({ presetId, items }) =>
    `Apply ${presetId} to ${items.length} text item${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles, presetId, styleScale }) => {
    const items = resolveItemHandles(handles, {
      allowSelection: false,
      itemTypes: ['text'],
    }).filter((item): item is TextItem => item.type === 'text')
    if (items.length === 0) throw new Error('No text items were found.')
    const project = useProjectStore.getState().currentProject
    const fps = useTimelineSettingsStore.getState().fps
    const canvas = {
      width: project?.metadata.width ?? 1920,
      height: project?.metadata.height ?? 1080,
      fps,
    }
    const updates = items.flatMap((item) => {
      const patch = applyTextStylePresetToItem(
        item,
        presetId,
        canvas,
        styleScale ?? item.textStyleScale ?? 1,
      )
      return hasItemChanges(item, patch as Partial<TimelineItem>) ? [{ item, patch }] : []
    })
    if (updates.length > 0) {
      executeTimelineCommand(
        'AGENT_APPLY_TEXT_STYLE_PRESET',
        () => {
          const store = useItemsStore.getState()
          for (const update of updates) {
            store._updateItem(update.item.id, update.patch as Partial<TimelineItem>)
          }
          useTimelineSettingsStore.getState().markDirty()
        },
        { itemIds: updates.map((update) => update.item.id), presetId },
      )
    }
    return {
      ok: true,
      message:
        updates.length > 0
          ? `Applied ${presetId} to ${updates.length} text item${updates.length === 1 ? '' : 's'}.`
          : 'Text styles were unchanged.',
      data: { itemIds: updates.map((update) => update.item.id), presetId },
      changed: updates.length > 0,
    }
  },
})

export const TEXT_CAPTION_PLATFORM_TOOLS = [
  editSubtitleCues,
  manageTranscriptCaptions,
  editText,
  listTextStylePresets,
  applyTextStylePreset,
] as const
