import { z } from 'zod'
import {
  getActiveExportSequenceId,
  getExportableSequence,
  useCompositionNavigationStore,
  useTimelineStore,
} from '@/features/editor/deps/timeline-contract'
import { useProjectStore } from '@/features/editor/deps/projects'
import { useSelectionStore } from '@/shared/state/selection'
import type { ProjectResolution } from '@/types/project'
import type { TimelineItem, TimelineTrack } from '@/types/timeline'
import type { ItemKeyframes } from '@/types/keyframe'
import type { Transition } from '@/types/transition'
import type { ProjectMarker } from '@/types/timeline'
import type { AudioEqSettings } from '@/types/audio'
import type {
  EditorAgentTool,
  JsonSchema,
  ToolResult,
  ToolValidation,
} from '../types'
import { buildClipRefs, resolveClipRef } from '../clip-refs'

export function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

function makeValidate<S extends z.ZodType>(schema: S): (args: unknown) => ToolValidation {
  return (args) => {
    const result = schema.safeParse(args ?? {})
    if (result.success) {
      return { ok: true, value: result.data as Record<string, unknown> }
    }
    const issue = result.error.issues[0]
    const path = issue?.path.join('.') || 'args'
    return { ok: false, error: `${path}: ${issue?.message ?? 'invalid'}` }
  }
}

export function definePlatformTool<S extends z.ZodType>(definition: {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema
  readOnly?: boolean
  destructive?: boolean
  handoff?: boolean
  requiresProject?: boolean
  schema: S
  summarize: (args: z.infer<S>) => string
  execute: (args: z.infer<S>) => Promise<ToolResult> | ToolResult
}): EditorAgentTool {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    readOnly: definition.readOnly ?? false,
    destructive: definition.destructive ?? false,
    handoff: definition.handoff ?? false,
    requiresProject: definition.requiresProject ?? true,
    validate: makeValidate(definition.schema),
    summarize: (args) => definition.summarize(args as z.infer<S>),
    execute: (args) => definition.execute(args as z.infer<S>),
  }
}

export interface ToolTimelineSnapshot {
  id: string | null
  name: string
  tracks: TimelineTrack[]
  items: TimelineItem[]
  transitions: Transition[]
  keyframes: ItemKeyframes[]
  markers: ProjectMarker[]
  fps: number
  width: number
  height: number
  backgroundColor?: string
  busAudioEq?: AudioEqSettings
  masterBusDb: number
  durationFrames: number
  inPoint: number | null
  outPoint: number | null
  scope: 'active' | 'main' | 'sequence'
}

function furthestItemEnd(items: TimelineItem[]): number {
  return items.reduce(
    (furthest, item) => Math.max(furthest, item.from + item.durationInFrames),
    0,
  )
}

export function getToolTimelineSnapshot(params: {
  scope: 'active' | 'main' | 'sequence'
  sequenceId?: string
}): ToolTimelineSnapshot {
  if (params.scope !== 'active') {
    const sequenceId = params.scope === 'main' ? null : params.sequenceId
    if (params.scope === 'sequence' && !sequenceId) {
      throw new Error('sequenceId is required when scope is "sequence".')
    }
    const sequence = getExportableSequence(sequenceId ?? null)
    return {
      ...sequence,
      scope: params.scope,
    }
  }

  const timeline = useTimelineStore.getState()
  const project = useProjectStore.getState().currentProject
  const navigation = useCompositionNavigationStore.getState()
  const activeCompositionId = navigation.activeCompositionId
  const activeName =
    navigation.breadcrumbs.at(-1)?.label ??
    (getActiveExportSequenceId() === null ? 'Main Timeline' : 'Sequence')
  const metadata: ProjectResolution = project?.metadata ?? {
    width: 1920,
    height: 1080,
    fps: timeline.fps,
  }

  return {
    id: activeCompositionId,
    name: activeName,
    tracks: timeline.tracks,
    items: timeline.items,
    transitions: timeline.transitions,
    keyframes: timeline.keyframes,
    markers: timeline.markers,
    fps: timeline.fps,
    width: metadata.width,
    height: metadata.height,
    backgroundColor: metadata.backgroundColor,
    masterBusDb: 0,
    durationFrames: furthestItemEnd(timeline.items),
    inPoint: timeline.inPoint,
    outPoint: timeline.outPoint,
    scope: 'active',
  }
}

export function resolveItemHandles(
  handles: readonly string[] | undefined,
  options: { allowSelection?: boolean; itemTypes?: TimelineItem['type'][] } = {},
): TimelineItem[] {
  buildClipRefs()
  const timelineItems = useTimelineStore.getState().items
  const itemById = new Map(timelineItems.map((item) => [item.id, item]))
  const requested =
    handles && handles.length > 0
      ? handles
      : options.allowSelection !== false
        ? useSelectionStore.getState().selectedItemIds
        : []
  const resolved = requested
    .map((handle) => itemById.get(handle) ?? itemById.get(resolveClipRef(handle) ?? ''))
    .filter((item): item is TimelineItem => !!item)
  const unique = [...new Map(resolved.map((item) => [item.id, item])).values()]
  return options.itemTypes
    ? unique.filter((item) => options.itemTypes!.includes(item.type))
    : unique
}

export function sanitizeTimelineItem(item: TimelineItem): Record<string, unknown> {
  const {
    src: _src,
    audioSrc: _audioSrc,
    thumbnailUrl: _thumbnailUrl,
    waveformData: _waveformData,
    reverseConformSrc: _reverseConformSrc,
    reverseConformPreviewSrc: _reverseConformPreviewSrc,
    textLayoutDrafts: _textLayoutDrafts,
    ...persisted
  } = item as TimelineItem & {
    src?: string
    audioSrc?: string
    thumbnailUrl?: string
    waveformData?: number[]
    reverseConformSrc?: string
    reverseConformPreviewSrc?: string
    textLayoutDrafts?: unknown
  }
  return persisted as Record<string, unknown>
}

export function buildItemRefMap(items: TimelineItem[]): Map<string, string> {
  const activeItems = useTimelineStore.getState().items
  if (items !== activeItems) return new Map()
  return new Map(buildClipRefs().map((entry) => [entry.itemId, entry.ref]))
}
