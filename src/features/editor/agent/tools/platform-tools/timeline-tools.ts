import { z } from 'zod'
import {
  closeSequenceTab,
  createClassicTrack,
  createSequence,
  executeTimelineCommand,
  listExportableSequences,
  renameCompoundClip,
  useCompositionNavigationStore,
  useItemsStore,
  useKeyframesStore,
  useTimelineCommandStore,
  useTimelineSettingsStore,
  useTimelineStore,
  useTransitionsStore,
} from '@/features/editor/deps/timeline-contract'
import { useProjectStore } from '@/features/editor/deps/projects'
import { createOperationId } from '@/shared/logging/logger'
import { usePlaybackStore } from '@/shared/state/playback'
import type { AudioEqSettings } from '@/types/audio'
import type { TimelineTrack } from '@/types/timeline'
import {
  definePlatformTool,
  objectSchema,
  resolveItemHandles,
} from './shared'

const saveProject = definePlatformTool({
  name: 'save_project',
  title: 'Save project',
  description:
    'Persist the current FreeCut timeline, sequences, effects, keyframes, audio state, and thumbnail to project.json.',
  inputSchema: objectSchema({
    projectId: { type: 'string', description: 'Defaults to the open project.' },
  }),
  schema: z.object({ projectId: z.string().min(1).optional() }),
  summarize: () => 'Save the current project',
  execute: async ({ projectId }) => {
    const currentProject = useProjectStore.getState().currentProject
    if (!currentProject) throw new Error('No project is currently open.')
    if (projectId && projectId !== currentProject.id) {
      throw new Error('save_project cannot write the open timeline into another project.')
    }
    const id = currentProject.id
    const operationId = createOperationId()
    await useTimelineStore.getState().saveTimeline(id)
    return {
      ok: true,
      message: `Saved project ${id}.`,
      data: { projectId: id, savedAt: Date.now() },
      operationId,
      changed: false,
    }
  },
})

const undo = definePlatformTool({
  name: 'undo',
  title: 'Undo timeline change',
  description: 'Undo the last command in the current Main/sequence editing context.',
  inputSchema: objectSchema({}),
  schema: z.object({}),
  summarize: () => 'Undo the last timeline change',
  execute: () => {
    const history = useTimelineCommandStore.getState()
    const label = history.getUndoLabel()
    if (!history.canUndo) {
      return {
        ok: false,
        message: 'There is no timeline command to undo.',
        error: { code: 'NOTHING_TO_UNDO', message: 'There is no timeline command to undo.' },
      }
    }
    history.undo()
    const next = useTimelineCommandStore.getState()
    return {
      ok: true,
      message: `Undid ${label ?? 'the last timeline command'}.`,
      data: {
        label,
        canUndo: next.canUndo,
        canRedo: next.canRedo,
        undoCount: next.undoStack.length,
        redoCount: next.redoStack.length,
      },
      changed: true,
    }
  },
})

const redo = definePlatformTool({
  name: 'redo',
  title: 'Redo timeline change',
  description: 'Redo the next command in the current Main/sequence editing context.',
  inputSchema: objectSchema({}),
  schema: z.object({}),
  summarize: () => 'Redo the next timeline change',
  execute: () => {
    const history = useTimelineCommandStore.getState()
    const label = history.getRedoLabel()
    if (!history.canRedo) {
      return {
        ok: false,
        message: 'There is no timeline command to redo.',
        error: { code: 'NOTHING_TO_REDO', message: 'There is no timeline command to redo.' },
      }
    }
    history.redo()
    const next = useTimelineCommandStore.getState()
    return {
      ok: true,
      message: `Redid ${label ?? 'the next timeline command'}.`,
      data: {
        label,
        canUndo: next.canUndo,
        canRedo: next.canRedo,
        undoCount: next.undoStack.length,
        redoCount: next.redoStack.length,
      },
      changed: true,
    }
  },
})

const createSequenceTool = definePlatformTool({
  name: 'create_sequence',
  title: 'Create sequence',
  description: 'Create an empty standalone timeline sequence and switch the editor to it.',
  inputSchema: objectSchema({ name: { type: 'string' } }),
  schema: z.object({ name: z.string().trim().min(1).max(120).optional() }),
  summarize: ({ name }) => `Create sequence${name ? ` "${name}"` : ''}`,
  execute: ({ name }) => {
    const sequenceId = createSequence(name)
    return {
      ok: true,
      message: `Created sequence ${name ?? sequenceId}.`,
      data: { sequenceId, name },
      changed: true,
    }
  },
})

const switchSequence = definePlatformTool({
  name: 'switch_sequence',
  title: 'Switch sequence',
  description: 'Switch the live editor to Main or a top-level sequence.',
  inputSchema: objectSchema({
    sequenceId: {
      type: ['string', 'null'],
      description: 'Sequence id. Use null for Main.',
    },
  }),
  schema: z.object({ sequenceId: z.string().min(1).nullable() }),
  summarize: ({ sequenceId }) => `Switch to ${sequenceId ?? 'Main'}`,
  execute: ({ sequenceId }) => {
    if (
      sequenceId !== null &&
      !listExportableSequences().some((sequence) => sequence.id === sequenceId)
    ) {
      throw new Error(`Sequence not found: ${sequenceId}`)
    }
    useCompositionNavigationStore.getState().switchToSequence(sequenceId)
    return {
      ok: true,
      message: `Switched to ${sequenceId ?? 'Main Timeline'}.`,
      data: { sequenceId },
      changed: false,
    }
  },
})

const renameSequence = definePlatformTool({
  name: 'rename_sequence',
  title: 'Rename sequence',
  description: 'Rename a sequence/composition and every wrapper that references it.',
  inputSchema: objectSchema(
    {
      sequenceId: { type: 'string' },
      name: { type: 'string' },
    },
    ['sequenceId', 'name'],
  ),
  schema: z.object({
    sequenceId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
  }),
  summarize: ({ name }) => `Rename sequence to "${name}"`,
  execute: ({ sequenceId, name }) => {
    if (!renameCompoundClip(sequenceId, name)) {
      throw new Error(`Sequence not found or unchanged: ${sequenceId}`)
    }
    return {
      ok: true,
      message: `Renamed sequence to "${name}".`,
      data: { sequenceId, name },
      changed: true,
    }
  },
})

const closeSequence = definePlatformTool({
  name: 'close_sequence',
  title: 'Close sequence tab',
  description:
    'Remove a sequence from the top-level tab list without deleting its composition content.',
  inputSchema: objectSchema(
    { sequenceId: { type: 'string' } },
    ['sequenceId'],
  ),
  schema: z.object({ sequenceId: z.string().min(1) }),
  summarize: ({ sequenceId }) => `Close sequence ${sequenceId}`,
  execute: ({ sequenceId }) => {
    if (!closeSequenceTab(sequenceId)) {
      throw new Error(`Sequence tab not found: ${sequenceId}`)
    }
    return {
      ok: true,
      message: `Closed sequence tab ${sequenceId}.`,
      data: { sequenceId },
      changed: true,
    }
  },
})

const createTrack = definePlatformTool({
  name: 'create_track',
  title: 'Create timeline track',
  description: 'Create a video or audio track at a requested order in the active timeline.',
  inputSchema: objectSchema(
    {
      kind: { type: 'string', enum: ['video', 'audio'] },
      order: { type: 'number', minimum: 0 },
    },
    ['kind'],
  ),
  schema: z.object({
    kind: z.enum(['video', 'audio']),
    order: z.number().int().min(0).optional(),
  }),
  summarize: ({ kind }) => `Create ${kind} track`,
  execute: ({ kind, order }) => {
    const timeline = useTimelineStore.getState()
    const targetOrder =
      order ?? (timeline.tracks.length > 0 ? Math.max(...timeline.tracks.map((t) => t.order)) + 1 : 0)
    const track = createClassicTrack({
      tracks: timeline.tracks,
      kind,
      order: targetOrder,
    })
    timeline.setTracks([...timeline.tracks, track])
    return {
      ok: true,
      message: `Created ${track.name}.`,
      data: track,
      changed: true,
    }
  },
})

const updateTrack = definePlatformTool({
  name: 'update_track',
  title: 'Update timeline track',
  description:
    'Update active-timeline track lock, sync lock, visibility, mute, solo, gain, name, or EQ.',
  inputSchema: objectSchema(
    {
      trackId: { type: 'string' },
      name: { type: 'string' },
      locked: { type: 'boolean' },
      syncLock: { type: 'boolean' },
      visible: { type: 'boolean' },
      muted: { type: 'boolean' },
      solo: { type: 'boolean' },
      volumeDb: { type: 'number', minimum: -60, maximum: 12 },
      audioEq: { type: 'object' },
    },
    ['trackId'],
  ),
  schema: z.object({
    trackId: z.string().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    locked: z.boolean().optional(),
    syncLock: z.boolean().optional(),
    visible: z.boolean().optional(),
    muted: z.boolean().optional(),
    solo: z.boolean().optional(),
    volumeDb: z.number().min(-60).max(12).optional(),
    audioEq: z.record(z.string(), z.unknown()).optional(),
  }),
  summarize: ({ trackId }) => `Update track ${trackId}`,
  execute: ({ trackId, volumeDb, audioEq, ...updates }) => {
    const timeline = useTimelineStore.getState()
    const track = timeline.tracks.find((candidate) => candidate.id === trackId)
    if (!track) throw new Error(`Track not found: ${trackId}`)
    const nextTrack: TimelineTrack = {
      ...track,
      ...updates,
      ...(volumeDb !== undefined ? { volume: volumeDb } : {}),
      ...(audioEq !== undefined ? { audioEq: audioEq as AudioEqSettings } : {}),
    }
    timeline.setTracks(
      timeline.tracks.map((candidate) => (candidate.id === trackId ? nextTrack : candidate)),
    )
    return {
      ok: true,
      message: `Updated track ${track.name}.`,
      data: nextTrack,
      changed: true,
    }
  },
})

const deleteTrack = definePlatformTool({
  name: 'delete_track',
  title: 'Delete timeline track',
  description:
    'Delete an active-timeline track and every item, transition, and keyframe owned by it.',
  inputSchema: objectSchema(
    { trackId: { type: 'string' } },
    ['trackId'],
  ),
  destructive: true,
  schema: z.object({ trackId: z.string().min(1) }),
  summarize: ({ trackId }) => `Delete track ${trackId}`,
  execute: ({ trackId }) => {
    const itemsStore = useItemsStore.getState()
    const track = itemsStore.tracks.find((candidate) => candidate.id === trackId)
    if (!track) throw new Error(`Track not found: ${trackId}`)
    const itemIds = itemsStore.items
      .filter((item) => item.trackId === trackId)
      .map((item) => item.id)
    executeTimelineCommand(
      'DELETE_TRACK',
      () => {
        const currentItems = useItemsStore.getState()
        currentItems._removeItems(itemIds)
        currentItems.setTracks(currentItems.tracks.filter((candidate) => candidate.id !== trackId))
        useTransitionsStore.getState()._removeTransitionsForItems(itemIds)
        useKeyframesStore.getState()._removeKeyframesForItems(itemIds)
        useTimelineSettingsStore.getState().markDirty()
      },
      { trackId, itemIds },
    )
    return {
      ok: true,
      message: `Deleted track ${track.name} and ${itemIds.length} item${itemIds.length === 1 ? '' : 's'}.`,
      data: { trackId, itemIds },
      changed: true,
    }
  },
})

const moveClips = definePlatformTool({
  name: 'move_clips',
  title: 'Move timeline items',
  description:
    'Move one or more active-timeline items by a relative time delta and optionally onto one track.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      deltaSeconds: { type: 'number' },
      trackId: { type: 'string' },
    },
    ['items', 'deltaSeconds'],
  ),
  schema: z.object({
    items: z.array(z.string()).min(1),
    deltaSeconds: z.number(),
    trackId: z.string().min(1).optional(),
  }),
  summarize: ({ items, deltaSeconds }) =>
    `Move ${items.length} item${items.length === 1 ? '' : 's'} by ${deltaSeconds}s`,
  execute: ({ items: handles, deltaSeconds, trackId }) => {
    const items = resolveItemHandles(handles, { allowSelection: false })
    if (items.length === 0) throw new Error('None of those timeline items exist.')
    const timeline = useTimelineStore.getState()
    if (trackId && !timeline.tracks.some((track) => track.id === trackId)) {
      throw new Error(`Track not found: ${trackId}`)
    }
    const deltaFrames = Math.round(deltaSeconds * timeline.fps)
    const updates = items.map((item) => ({
      id: item.id,
      from: Math.max(0, item.from + deltaFrames),
      ...(trackId ? { trackId } : {}),
    }))
    timeline.moveItems(updates)
    return {
      ok: true,
      message: `Moved ${updates.length} timeline item${updates.length === 1 ? '' : 's'}.`,
      data: updates,
      changed: true,
    }
  },
})

const duplicateClips = definePlatformTool({
  name: 'duplicate_clips',
  title: 'Duplicate timeline items',
  description:
    'Duplicate active-timeline items at a relative time offset while preserving their source and effects.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      offsetSeconds: { type: 'number' },
      trackId: { type: 'string' },
    },
    ['items', 'offsetSeconds'],
  ),
  schema: z.object({
    items: z.array(z.string()).min(1),
    offsetSeconds: z.number(),
    trackId: z.string().min(1).optional(),
  }),
  summarize: ({ items }) => `Duplicate ${items.length} timeline item${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles, offsetSeconds, trackId }) => {
    const items = resolveItemHandles(handles, { allowSelection: false })
    if (items.length === 0) throw new Error('None of those timeline items exist.')
    const timeline = useTimelineStore.getState()
    if (trackId && !timeline.tracks.some((track) => track.id === trackId)) {
      throw new Error(`Track not found: ${trackId}`)
    }
    const offsetFrames = Math.round(offsetSeconds * timeline.fps)
    const positions = items.map((item) => ({
      from: Math.max(0, item.from + offsetFrames),
      trackId: trackId ?? item.trackId,
    }))
    const duplicated = timeline.duplicateItems(items.map((item) => item.id), positions)
    return {
      ok: true,
      message: `Duplicated ${duplicated.length} timeline item${duplicated.length === 1 ? '' : 's'}.`,
      data: duplicated.map((item) => ({
        id: item.id,
        trackId: item.trackId,
        from: item.from,
        durationInFrames: item.durationInFrames,
      })),
      changed: duplicated.length > 0,
    }
  },
})

const deleteItems = definePlatformTool({
  name: 'delete_items',
  title: 'Delete timeline items',
  description:
    'Delete active-timeline items exactly or with ripple gap closing. Unlike delete_clips, exact deletion leaves timing gaps.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      ripple: { type: 'boolean' },
    },
    ['items'],
  ),
  destructive: true,
  schema: z.object({
    items: z.array(z.string()).min(1),
    ripple: z.boolean().optional(),
  }),
  summarize: ({ items, ripple }) =>
    `${ripple ? 'Ripple-delete' : 'Delete'} ${items.length} timeline item${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles, ripple = false }) => {
    const items = resolveItemHandles(handles, { allowSelection: false })
    if (items.length === 0) throw new Error('None of those timeline items exist.')
    const ids = items.map((item) => item.id)
    const timeline = useTimelineStore.getState()
    if (ripple) timeline.rippleDeleteItems(ids)
    else timeline.removeItems(ids)
    return {
      ok: true,
      message: `${ripple ? 'Ripple-deleted' : 'Deleted'} ${ids.length} timeline item${ids.length === 1 ? '' : 's'}.`,
      data: { itemIds: ids, ripple },
      changed: true,
    }
  },
})

const closeGap = definePlatformTool({
  name: 'close_gap',
  title: 'Close timeline gap',
  description: 'Close one gap at a time position or all gaps on an active-timeline track.',
  inputSchema: objectSchema(
    {
      trackId: { type: 'string' },
      atSeconds: { type: 'number', minimum: 0 },
      all: { type: 'boolean' },
    },
    ['trackId'],
  ),
  schema: z.object({
    trackId: z.string().min(1),
    atSeconds: z.number().min(0).optional(),
    all: z.boolean().optional(),
  }),
  summarize: ({ trackId }) => `Close gap on ${trackId}`,
  execute: ({ trackId, atSeconds, all = false }) => {
    const timeline = useTimelineStore.getState()
    if (!timeline.tracks.some((track) => track.id === trackId)) {
      throw new Error(`Track not found: ${trackId}`)
    }
    if (all) timeline.closeAllGapsOnTrack(trackId)
    else {
      const frame =
        atSeconds === undefined
          ? usePlaybackStore.getState().currentFrame
          : Math.round(atSeconds * timeline.fps)
      timeline.closeGapAtPosition(trackId, frame)
    }
    return {
      ok: true,
      message: `${all ? 'Closed all gaps' : 'Closed the gap'} on track ${trackId}.`,
      data: { trackId, all, atSeconds },
      changed: true,
    }
  },
})

const setInOut = definePlatformTool({
  name: 'set_in_out',
  title: 'Set timeline in/out range',
  description: 'Set or clear the active timeline export/playback range.',
  inputSchema: objectSchema({
    startSeconds: { type: 'number', minimum: 0 },
    endSeconds: { type: 'number', minimum: 0 },
    clear: { type: 'boolean' },
  }),
  schema: z.object({
    startSeconds: z.number().min(0).optional(),
    endSeconds: z.number().min(0).optional(),
    clear: z.boolean().optional(),
  }),
  summarize: ({ clear }) => (clear ? 'Clear timeline in/out range' : 'Set timeline in/out range'),
  execute: ({ startSeconds, endSeconds, clear = false }) => {
    const timeline = useTimelineStore.getState()
    if (clear) {
      timeline.clearInOutPoints()
    } else {
      if (startSeconds !== undefined) {
        timeline.setInPoint(Math.round(startSeconds * timeline.fps))
      }
      if (endSeconds !== undefined) {
        timeline.setOutPoint(Math.round(endSeconds * timeline.fps))
      }
    }
    return {
      ok: true,
      message: clear ? 'Cleared timeline in/out range.' : 'Updated timeline in/out range.',
      data: {
        inPoint: useTimelineStore.getState().inPoint,
        outPoint: useTimelineStore.getState().outPoint,
      },
      changed: true,
    }
  },
})

const manageMarker = definePlatformTool({
  name: 'manage_marker',
  title: 'Manage timeline marker',
  description: 'Add, update, remove, or clear markers on the active timeline.',
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['add', 'update', 'remove', 'clear'] },
      markerId: { type: 'string' },
      seconds: { type: 'number', minimum: 0 },
      label: { type: 'string' },
      color: { type: 'string' },
    },
    ['operation'],
  ),
  schema: z.object({
    operation: z.enum(['add', 'update', 'remove', 'clear']),
    markerId: z.string().min(1).optional(),
    seconds: z.number().min(0).optional(),
    label: z.string().max(240).optional(),
    color: z.string().min(1).optional(),
  }),
  summarize: ({ operation }) => `${operation} timeline marker`,
  execute: ({ operation, markerId, seconds, label, color }) => {
    const timeline = useTimelineStore.getState()
    if (operation === 'clear') {
      timeline.clearAllMarkers()
    } else if (operation === 'add') {
      if (seconds === undefined) throw new Error('seconds is required to add a marker.')
      timeline.addMarker(Math.round(seconds * timeline.fps), color, label)
    } else if (operation === 'remove') {
      if (!markerId) throw new Error('markerId is required to remove a marker.')
      timeline.removeMarker(markerId)
    } else {
      if (!markerId) throw new Error('markerId is required to update a marker.')
      timeline.updateMarker(markerId, {
        ...(seconds !== undefined ? { frame: Math.round(seconds * timeline.fps) } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(color !== undefined ? { color } : {}),
      })
    }
    return {
      ok: true,
      message: `${operation === 'clear' ? 'Cleared' : `${operation}d`} timeline marker${operation === 'clear' ? 's' : ''}.`,
      data: useTimelineStore.getState().markers,
      changed: true,
    }
  },
})

export const TIMELINE_PLATFORM_TOOLS = [
  saveProject,
  undo,
  redo,
  createSequenceTool,
  switchSequence,
  renameSequence,
  closeSequence,
  createTrack,
  updateTrack,
  deleteTrack,
  moveClips,
  duplicateClips,
  deleteItems,
  closeGap,
  setInOut,
  manageMarker,
] as const
