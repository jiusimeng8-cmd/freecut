import { z } from 'zod'
import {
  createPreComp,
  deleteCompoundClips,
  dissolvePreComp,
  executeTimelineCommand,
  insertFreezeFrame,
  joinItems,
  linkItems,
  openCompositionAsTab,
  rateStretchItemWithoutHistory,
  resetSpeedWithRipple,
  reverseItems,
  rollingTrimItems,
  slideItem,
  slipItem,
  trackPushItems,
  unlinkItems,
  useCompositionsStore,
  useItemsStore,
  useReverseConformDialogStore,
  useTimelineStore,
} from '@/features/editor/deps/timeline-contract'
import {
  sourceToTimelineFrames,
  timelineToSourceFrames,
} from '@/features/editor/deps/timeline-utils'
import { usePlaybackStore } from '@/shared/state/playback'
import type { TimelineItem, TimelineTrack } from '@/types/timeline'
import {
  definePlatformTool,
  objectSchema,
  resolveItemHandles,
} from './shared'

function requireItem(handle: string): TimelineItem {
  const [item] = resolveItemHandles([handle], { allowSelection: false })
  if (!item) throw new Error(`Timeline item not found: ${handle}`)
  return item
}

function timelineFrames(seconds: number): number {
  return Math.round(seconds * useTimelineStore.getState().fps)
}

function isAnimatedImage(item: TimelineItem): boolean {
  if (item.type !== 'image') return false
  const label = item.label?.toLowerCase() ?? ''
  return label.endsWith('.gif') || label.endsWith('.webp')
}

const manageItemLinks = definePlatformTool({
  name: 'manage_item_links',
  title: 'Link or unlink timeline items',
  description:
    'Create or break linked timeline groups so synchronized video, audio, subtitles, and overlays move together.',
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['link', 'unlink'] },
      items: { type: 'array', items: { type: 'string' } },
    },
    ['operation', 'items'],
  ),
  schema: z.object({
    operation: z.enum(['link', 'unlink']),
    items: z.array(z.string().min(1)).min(1),
  }),
  summarize: ({ operation, items }) =>
    `${operation} ${items.length} timeline item${items.length === 1 ? '' : 's'}`,
  execute: ({ operation, items: handles }) => {
    const items = resolveItemHandles(handles, { allowSelection: false })
    if (items.length !== new Set(handles).size) {
      throw new Error('One or more timeline items do not exist.')
    }
    if (operation === 'link') {
      if (!linkItems(items.map((item) => item.id))) {
        throw new Error('Those items cannot be linked or already form one linked group.')
      }
    } else {
      unlinkItems(items.map((item) => item.id))
    }
    const updatedById = useTimelineStore.getState().items.reduce<Record<string, string | undefined>>(
      (result, item) => {
        if (items.some((candidate) => candidate.id === item.id)) {
          result[item.id] = item.linkedGroupId
        }
        return result
      },
      {},
    )
    return {
      ok: true,
      message: `${operation === 'link' ? 'Linked' : 'Unlinked'} ${items.length} timeline item${items.length === 1 ? '' : 's'}.`,
      data: { itemIds: items.map((item) => item.id), linkedGroupIds: updatedById },
      changed: true,
    }
  },
})

const joinTimelineItems = definePlatformTool({
  name: 'join_items',
  title: 'Join timeline items',
  description:
    'Join compatible adjacent split segments back into continuous items in one undoable operation.',
  inputSchema: objectSchema(
    { items: { type: 'array', items: { type: 'string' } } },
    ['items'],
  ),
  destructive: true,
  schema: z.object({ items: z.array(z.string().min(1)).min(2) }),
  summarize: ({ items }) => `Join ${items.length} timeline items`,
  execute: ({ items: handles }) => {
    const items = resolveItemHandles(handles, { allowSelection: false })
    if (items.length < 2) throw new Error('At least two existing timeline items are required.')
    const beforeIds = new Set(useTimelineStore.getState().items.map((item) => item.id))
    joinItems(items.map((item) => item.id))
    const afterItems = useTimelineStore.getState().items
    const removedIds = [...beforeIds].filter(
      (id) => !afterItems.some((candidate) => candidate.id === id),
    )
    if (removedIds.length === 0) {
      throw new Error('Those items could not be joined.')
    }
    const survivors = items
      .map((item) => afterItems.find((candidate) => candidate.id === item.id))
      .filter((item): item is TimelineItem => !!item)
    return {
      ok: true,
      message: `Joined ${items.length} timeline items.`,
      data: {
        survivingItemIds: survivors.map((item) => item.id),
        removedItemIds: removedIds,
      },
      changed: true,
    }
  },
})

const slipClip = definePlatformTool({
  name: 'slip_clip',
  title: 'Slip clip source',
  description:
    'Shift a clip source window without changing its timeline position or duration.',
  inputSchema: objectSchema(
    {
      item: { type: 'string' },
      deltaSeconds: { type: 'number' },
    },
    ['item', 'deltaSeconds'],
  ),
  schema: z.object({
    item: z.string().min(1),
    deltaSeconds: z.number(),
  }),
  summarize: ({ deltaSeconds }) => `Slip clip source by ${deltaSeconds}s`,
  execute: ({ item: handle, deltaSeconds }) => {
    const item = requireItem(handle)
    if (!['video', 'audio', 'composition'].includes(item.type)) {
      throw new Error('Only video, audio, or composition items can be slipped.')
    }
    const sourceFps = item.sourceFps ?? useTimelineStore.getState().fps
    const deltaSourceFrames = Math.round(deltaSeconds * sourceFps)
    if (deltaSourceFrames === 0) throw new Error('deltaSeconds is too small to change one frame.')
    slipItem(item.id, deltaSourceFrames)
    const updated = requireItem(item.id)
    return {
      ok: true,
      message: `Slipped ${item.label} by ${deltaSeconds}s.`,
      data: {
        itemId: item.id,
        deltaSourceFrames,
        sourceStart: updated.sourceStart,
        sourceEnd: updated.sourceEnd,
      },
      changed: true,
    }
  },
})

const slideClip = definePlatformTool({
  name: 'slide_clip',
  title: 'Slide clip edit',
  description:
    'Move a clip in time while trimming its adjacent neighbors to preserve the surrounding range.',
  inputSchema: objectSchema(
    {
      item: { type: 'string' },
      deltaSeconds: { type: 'number' },
      leftNeighbor: { type: 'string' },
      rightNeighbor: { type: 'string' },
    },
    ['item', 'deltaSeconds'],
  ),
  schema: z.object({
    item: z.string().min(1),
    deltaSeconds: z.number(),
    leftNeighbor: z.string().min(1).optional(),
    rightNeighbor: z.string().min(1).optional(),
  }),
  summarize: ({ deltaSeconds }) => `Slide clip by ${deltaSeconds}s`,
  execute: ({ item: handle, deltaSeconds, leftNeighbor, rightNeighbor }) => {
    const item = requireItem(handle)
    const deltaFrames = timelineFrames(deltaSeconds)
    if (deltaFrames === 0) throw new Error('deltaSeconds is too small to change one frame.')
    const sameTrack = useTimelineStore
      .getState()
      .items.filter((candidate) => candidate.trackId === item.trackId && candidate.id !== item.id)
      .sort((left, right) => left.from - right.from)
    const inferredLeft = [...sameTrack]
      .reverse()
      .find((candidate) => candidate.from + candidate.durationInFrames === item.from)
    const itemEnd = item.from + item.durationInFrames
    const inferredRight = sameTrack.find((candidate) => candidate.from === itemEnd)
    const left = leftNeighbor ? requireItem(leftNeighbor) : inferredLeft
    const right = rightNeighbor ? requireItem(rightNeighbor) : inferredRight
    if (
      left &&
      (left.trackId !== item.trackId || left.from + left.durationInFrames !== item.from)
    ) {
      throw new Error('leftNeighbor must be directly adjacent on the same track.')
    }
    if (right && (right.trackId !== item.trackId || right.from !== itemEnd)) {
      throw new Error('rightNeighbor must be directly adjacent on the same track.')
    }
    if (!left && !right) {
      throw new Error('The clip must have at least one directly adjacent neighbor.')
    }
    const leftId = left?.id ?? null
    const rightId = right?.id ?? null
    slideItem(item.id, deltaFrames, leftId, rightId)
    const updated = requireItem(item.id)
    return {
      ok: true,
      message: `Slid ${item.label} by ${deltaSeconds}s.`,
      data: {
        itemId: item.id,
        deltaFrames,
        leftNeighborId: leftId,
        rightNeighborId: rightId,
        from: updated.from,
      },
      changed: true,
    }
  },
})

const rollingTrim = definePlatformTool({
  name: 'rolling_trim',
  title: 'Roll an edit point',
  description:
    'Move the cut between adjacent items while keeping their combined timeline duration unchanged.',
  inputSchema: objectSchema(
    {
      leftItem: { type: 'string' },
      rightItem: { type: 'string' },
      deltaSeconds: { type: 'number' },
    },
    ['leftItem', 'rightItem', 'deltaSeconds'],
  ),
  schema: z.object({
    leftItem: z.string().min(1),
    rightItem: z.string().min(1),
    deltaSeconds: z.number(),
  }),
  summarize: ({ deltaSeconds }) => `Roll edit point by ${deltaSeconds}s`,
  execute: ({ leftItem, rightItem, deltaSeconds }) => {
    const left = requireItem(leftItem)
    const right = requireItem(rightItem)
    if (
      left.trackId !== right.trackId ||
      left.from + left.durationInFrames !== right.from
    ) {
      throw new Error('Rolling trim items must be directly adjacent on the same track.')
    }
    const deltaFrames = timelineFrames(deltaSeconds)
    if (deltaFrames === 0) throw new Error('deltaSeconds is too small to change one frame.')
    rollingTrimItems(left.id, right.id, deltaFrames)
    const state = useTimelineStore.getState()
    return {
      ok: true,
      message: `Rolled the edit point by ${deltaSeconds}s.`,
      data: {
        leftItem: state.items.find((item) => item.id === left.id),
        rightItem: state.items.find((item) => item.id === right.id),
      },
      changed: true,
    }
  },
})

const pushTimeline = definePlatformTool({
  name: 'push_timeline',
  title: 'Push timeline items',
  description:
    'Move every item at or after an anchor item across all tracks by one shared time delta.',
  inputSchema: objectSchema(
    {
      anchorItem: { type: 'string' },
      deltaSeconds: { type: 'number' },
    },
    ['anchorItem', 'deltaSeconds'],
  ),
  schema: z.object({
    anchorItem: z.string().min(1),
    deltaSeconds: z.number(),
  }),
  summarize: ({ deltaSeconds }) => `Push timeline by ${deltaSeconds}s`,
  execute: ({ anchorItem, deltaSeconds }) => {
    const anchor = requireItem(anchorItem)
    const deltaFrames = timelineFrames(deltaSeconds)
    if (deltaFrames === 0) throw new Error('deltaSeconds is too small to change one frame.')
    trackPushItems(anchor.id, deltaFrames)
    return {
      ok: true,
      message: `Pushed timeline items by ${deltaSeconds}s from ${anchor.label}.`,
      data: { anchorItemId: anchor.id, cutFrame: anchor.from, deltaFrames },
      changed: true,
    }
  },
})

const resetClipSpeed = definePlatformTool({
  name: 'reset_clip_speed',
  title: 'Reset clip speed',
  description: 'Reset selected video, audio, GIF, or animated WebP items to 1x speed.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      preserveDuration: {
        type: 'boolean',
        description:
          'Keep each clip duration unchanged. Defaults to true for animated images and false for video/audio, matching the editor UI.',
      },
    },
    ['items'],
  ),
  schema: z.object({
    items: z.array(z.string().min(1)).min(1),
    preserveDuration: z.boolean().optional(),
  }),
  summarize: ({ items }) => `Reset speed for ${items.length} item${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles, preserveDuration }) => {
    const items = resolveItemHandles(handles, { allowSelection: false }).filter(
      (item) => ['video', 'audio'].includes(item.type) || isAnimatedImage(item),
    )
    if (items.length === 0) throw new Error('No speed-adjustable items were found.')

    const itemsToReset = items.filter((item) => Math.abs((item.speed || 1) - 1) > 0.01)
    if (itemsToReset.length === 0) {
      return {
        ok: true,
        message: 'The selected items were already at 1x speed.',
        data: { itemIds: [] },
        changed: false,
      }
    }

    const beforeById = new Map(
      itemsToReset.map((item) => [
        item.id,
        {
          from: item.from,
          durationInFrames: item.durationInFrames,
          speed: item.speed ?? 1,
          sourceEnd: item.sourceEnd,
        },
      ]),
    )
    const fps = useTimelineStore.getState().fps
    const resetWithoutHistory = (target: TimelineItem) => {
      const item = useItemsStore.getState().itemById[target.id]
      if (!item || Math.abs((item.speed || 1) - 1) <= 0.01) return

      const keepDuration = preserveDuration ?? item.type === 'image'
      const currentSpeed = item.speed ?? 1
      const sourceFps = item.sourceFps ?? fps
      const effectiveSourceFrames =
        item.type !== 'image' && item.sourceEnd !== undefined && item.sourceStart !== undefined
          ? item.sourceEnd - item.sourceStart
          : timelineToSourceFrames(item.durationInFrames, currentSpeed, fps, sourceFps)
      const newDuration = keepDuration
        ? item.durationInFrames
        : Math.max(1, sourceToTimelineFrames(effectiveSourceFrames, 1, sourceFps, fps))

      rateStretchItemWithoutHistory(item.id, item.from, newDuration, 1)

      const updated = useItemsStore.getState().itemById[item.id]
      if (
        updated &&
        (item.type === 'image' || keepDuration) &&
        (Math.abs((updated.speed ?? 1) - 1) > Number.EPSILON ||
          updated.durationInFrames !== newDuration)
      ) {
        const sourceStart = item.sourceStart ?? 0
        const requestedSourceEnd =
          sourceStart + timelineToSourceFrames(newDuration, 1, fps, sourceFps)
        useItemsStore.getState()._updateItem(item.id, {
          durationInFrames: newDuration,
          speed: 1,
          sourceEnd: Math.round(
            item.sourceDuration
              ? Math.min(requestedSourceEnd, item.sourceDuration)
              : requestedSourceEnd,
          ),
        })
      }
    }

    const mediaItems = itemsToReset.filter((item) => item.type === 'video' || item.type === 'audio')
    const imageItems = itemsToReset.filter((item) => item.type === 'image')

    if (preserveDuration !== true && mediaItems.length > 0) {
      resetSpeedWithRipple(mediaItems.map((item) => item.id))
      for (const item of imageItems) resetWithoutHistory(item)
    } else {
      executeTimelineCommand(
        'RESET_SPEED_WITH_RIPPLE',
        () => {
          for (const item of itemsToReset) resetWithoutHistory(item)
        },
        {
          ids: itemsToReset.map((item) => item.id),
          preserveDuration,
        },
      )
    }

    const afterById = useItemsStore.getState().itemById
    const changedIds = itemsToReset
      .filter((item) => {
        const before = beforeById.get(item.id)
        const after = afterById[item.id]
        return (
          !!before &&
          !!after &&
          (before.from !== after.from ||
            before.durationInFrames !== after.durationInFrames ||
            before.speed !== (after.speed ?? 1) ||
            before.sourceEnd !== after.sourceEnd)
        )
      })
      .map((item) => item.id)

    return {
      ok: true,
      message:
        changedIds.length > 0
          ? `Reset speed for ${changedIds.length} item${changedIds.length === 1 ? '' : 's'}.`
          : 'The selected items were unchanged.',
      data: { itemIds: changedIds },
      changed: changedIds.length > 0,
    }
  },
})

const setItemsReversed = definePlatformTool({
  name: 'set_items_reversed',
  title: 'Set timeline item reverse state',
  description:
    'Set reverse playback on or off for video/audio items. Repeating the same state is idempotent; enabling video reverse opens the existing conform task when needed.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      reversed: { type: 'boolean' },
    },
    ['items', 'reversed'],
  ),
  handoff: true,
  schema: z.object({
    items: z.array(z.string().min(1)).min(1),
    reversed: z.boolean(),
  }),
  summarize: ({ items, reversed }) =>
    `${reversed ? 'Enable' : 'Disable'} reverse for ${items.length} item${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles, reversed }) => {
    const items = resolveItemHandles(handles, {
      allowSelection: false,
      itemTypes: ['video', 'audio'],
    })
    if (items.length === 0) throw new Error('No reversible video/audio items were found.')
    const result = reverseItems(
      items.map((item) => item.id),
      reversed,
    )
    const handoffOpen =
      result.handoffOpen || useReverseConformDialogStore.getState().request !== null
    return {
      ok: true,
      message: handoffOpen
        ? 'Opened reverse media preparation.'
        : result.changed
          ? `${reversed ? 'Enabled' : 'Disabled'} reverse playback for ${result.itemIds.length} item${result.itemIds.length === 1 ? '' : 's'}.`
          : `Reverse playback was already ${reversed ? 'enabled' : 'disabled'}.`,
      data: {
        itemIds: result.itemIds,
        reversed,
        handoffOpen,
      },
      changed: result.changed,
    }
  },
})

const addFreezeFrame = definePlatformTool({
  name: 'insert_freeze_frame',
  title: 'Insert freeze frame',
  description:
    'Extract the video frame at an exact time, add it to the media library, split the source clip, and insert a two-second still.',
  inputSchema: objectSchema(
    {
      item: { type: 'string' },
      atSeconds: { type: 'number', minimum: 0 },
    },
    ['item'],
  ),
  schema: z.object({
    item: z.string().min(1),
    atSeconds: z.number().min(0).optional(),
  }),
  summarize: () => 'Insert freeze frame',
  execute: async ({ item: handle, atSeconds }) => {
    const item = requireItem(handle)
    if (item.type !== 'video') throw new Error('Freeze frames require a video item.')
    const frame =
      atSeconds === undefined
        ? usePlaybackStore.getState().currentFrame
        : timelineFrames(atSeconds)
    if (!(await insertFreezeFrame(item.id, frame))) {
      throw new Error('Could not insert a freeze frame at that time.')
    }
    return {
      ok: true,
      message: `Inserted a freeze frame into ${item.label}.`,
      data: { sourceItemId: item.id, frame },
      changed: true,
    }
  },
})

const createPrecomposition = definePlatformTool({
  name: 'create_precomp',
  title: 'Create pre-composition',
  description:
    'Convert selected timeline items into an editable nested composition with linked visual/audio wrappers.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      name: { type: 'string' },
    },
    ['items'],
  ),
  schema: z.object({
    items: z.array(z.string().min(1)).min(1),
    name: z.string().trim().min(1).max(120).optional(),
  }),
  summarize: ({ items }) => `Create pre-composition from ${items.length} item${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles, name }) => {
    const items = resolveItemHandles(handles, { allowSelection: false })
    if (items.length === 0) throw new Error('No timeline items were found.')
    const wrapper = createPreComp(name, items.map((item) => item.id))
    if (!wrapper?.compositionId) throw new Error('Could not create a pre-composition.')
    return {
      ok: true,
      message: `Created pre-composition ${name ?? wrapper.label}.`,
      data: {
        wrapperItemId: wrapper.id,
        compositionId: wrapper.compositionId,
        trackId: wrapper.trackId,
      },
      changed: true,
    }
  },
})

const dissolvePrecomposition = definePlatformTool({
  name: 'dissolve_precomp',
  title: 'Dissolve pre-composition',
  description:
    'Replace a composition wrapper with its editable child tracks, items, transitions, and keyframes.',
  inputSchema: objectSchema(
    { item: { type: 'string' } },
    ['item'],
  ),
  destructive: true,
  schema: z.object({ item: z.string().min(1) }),
  summarize: () => 'Dissolve pre-composition',
  execute: ({ item: handle }) => {
    const item = requireItem(handle)
    if (!dissolvePreComp(item.id)) throw new Error('That item is not a dissolvable composition.')
    return {
      ok: true,
      message: `Dissolved pre-composition ${item.label}.`,
      data: { wrapperItemId: item.id, compositionId: item.compositionId },
      changed: true,
    }
  },
})

const deleteCompositions = definePlatformTool({
  name: 'delete_compositions',
  title: 'Delete compositions',
  description:
    'Delete composition definitions and remove every wrapper reference across Main and nested timelines.',
  inputSchema: objectSchema(
    {
      compositionIds: { type: 'array', items: { type: 'string' } },
    },
    ['compositionIds'],
  ),
  destructive: true,
  schema: z.object({ compositionIds: z.array(z.string().min(1)).min(1) }),
  summarize: ({ compositionIds }) =>
    `Delete ${compositionIds.length} composition${compositionIds.length === 1 ? '' : 's'}`,
  execute: ({ compositionIds }) => {
    if (!deleteCompoundClips(compositionIds)) {
      throw new Error('No matching compositions were deleted.')
    }
    return {
      ok: true,
      message: `Deleted ${compositionIds.length} composition${compositionIds.length === 1 ? '' : 's'}.`,
      data: { compositionIds },
      changed: true,
    }
  },
})

const promoteComposition = definePlatformTool({
  name: 'open_composition_tab',
  title: 'Open composition as sequence',
  description:
    'Promote an existing nested composition to a standalone sequence tab and switch to it.',
  inputSchema: objectSchema(
    { compositionId: { type: 'string' } },
    ['compositionId'],
  ),
  schema: z.object({ compositionId: z.string().min(1) }),
  summarize: () => 'Open composition as sequence',
  execute: ({ compositionId }) => {
    if (!useCompositionsStore.getState().getComposition(compositionId)) {
      throw new Error(`Composition not found: ${compositionId}`)
    }
    const changed = openCompositionAsTab(compositionId)
    return {
      ok: true,
      message: changed
        ? `Opened composition ${compositionId} as a new sequence tab.`
        : `Switched to existing sequence ${compositionId}.`,
      data: { compositionId, promoted: changed },
      changed,
    }
  },
})

const reorderTracks = definePlatformTool({
  name: 'reorder_tracks',
  title: 'Reorder timeline tracks',
  description:
    'Move active-timeline tracks into a requested top-to-bottom order while preserving unspecified tracks.',
  inputSchema: objectSchema(
    { trackIds: { type: 'array', items: { type: 'string' } } },
    ['trackIds'],
  ),
  schema: z.object({ trackIds: z.array(z.string().min(1)).min(1) }),
  summarize: ({ trackIds }) => `Reorder ${trackIds.length} track${trackIds.length === 1 ? '' : 's'}`,
  execute: ({ trackIds }) => {
    if (new Set(trackIds).size !== trackIds.length) {
      throw new Error('trackIds must not contain duplicates.')
    }
    const timeline = useTimelineStore.getState()
    const byId = new Map(timeline.tracks.map((track) => [track.id, track]))
    const requested = trackIds.map((id) => byId.get(id))
    if (requested.some((track) => !track)) throw new Error('One or more tracks do not exist.')
    const requestedIds = new Set(trackIds)
    const remaining = [...timeline.tracks]
      .filter((track) => !requestedIds.has(track.id))
      .sort((left, right) => left.order - right.order)
    const next = [...(requested as TimelineTrack[]), ...remaining].map((track, order) => ({
      ...track,
      order,
    }))
    timeline.setTracks(next)
    return {
      ok: true,
      message: `Reordered ${trackIds.length} track${trackIds.length === 1 ? '' : 's'}.`,
      data: next.map((track) => ({ id: track.id, order: track.order })),
      changed: true,
    }
  },
})

const manageTrackGroup = definePlatformTool({
  name: 'manage_track_group',
  title: 'Group or ungroup tracks',
  description:
    'Create a collapsible track group or remove tracks from an existing group.',
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['group', 'ungroup'] },
      trackIds: { type: 'array', items: { type: 'string' } },
      groupId: { type: 'string' },
      name: { type: 'string' },
    },
    ['operation'],
  ),
  schema: z.object({
    operation: z.enum(['group', 'ungroup']),
    trackIds: z.array(z.string().min(1)).optional(),
    groupId: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(120).optional(),
  }),
  summarize: ({ operation }) => `${operation} timeline tracks`,
  execute: ({ operation, trackIds = [], groupId, name }) => {
    const timeline = useTimelineStore.getState()
    const sorted = [...timeline.tracks].sort((left, right) => left.order - right.order)
    if (operation === 'group') {
      if (trackIds.length === 0) throw new Error('trackIds is required to create a group.')
      const targetIds = new Set(trackIds)
      const targets = sorted.filter((track) => targetIds.has(track.id) && !track.isGroup)
      if (targets.length !== targetIds.size) {
        throw new Error('One or more tracks do not exist or are group headers.')
      }
      const insertIndex = Math.min(...targets.map((track) => sorted.indexOf(track)))
      const group: TimelineTrack = {
        id: crypto.randomUUID(),
        name: name ?? 'Track Group',
        height: 32,
        locked: false,
        syncLock: true,
        visible: true,
        muted: false,
        solo: false,
        order: insertIndex,
        items: [],
        isGroup: true,
        isCollapsed: false,
      }
      const remaining = sorted.filter((track) => !targetIds.has(track.id))
      const next = [
        ...remaining.slice(0, insertIndex),
        group,
        ...targets.map((track) => ({ ...track, parentTrackId: group.id })),
        ...remaining.slice(insertIndex),
      ].map((track, order) => ({ ...track, order }))
      timeline.setTracks(next)
      return {
        ok: true,
        message: `Grouped ${targets.length} tracks as ${group.name}.`,
        data: { groupId: group.id, trackIds: targets.map((track) => track.id) },
        changed: true,
      }
    }

    if (!groupId) throw new Error('groupId is required to ungroup tracks.')
    const group = sorted.find((track) => track.id === groupId && track.isGroup)
    if (!group) throw new Error(`Track group not found: ${groupId}`)
    const requestedIds = trackIds.length > 0 ? new Set(trackIds) : null
    const children = sorted.filter((track) => track.parentTrackId === groupId)
    const releasedIds = new Set(
      children
        .filter((track) => !requestedIds || requestedIds.has(track.id))
        .map((track) => track.id),
    )
    if (releasedIds.size === 0) throw new Error('No matching child tracks were found.')
    const keepsChildren = children.some((track) => !releasedIds.has(track.id))
    const next = sorted
      .filter((track) => keepsChildren || track.id !== groupId)
      .map((track) =>
        releasedIds.has(track.id) ? { ...track, parentTrackId: undefined } : track,
      )
      .map((track, order) => ({ ...track, order }))
    timeline.setTracks(next)
    return {
      ok: true,
      message: `Ungrouped ${releasedIds.size} track${releasedIds.size === 1 ? '' : 's'}.`,
      data: { groupId, trackIds: [...releasedIds], removedGroup: !keepsChildren },
      changed: true,
    }
  },
})

export const ADVANCED_TIMELINE_PLATFORM_TOOLS = [
  manageItemLinks,
  joinTimelineItems,
  slipClip,
  slideClip,
  rollingTrim,
  pushTimeline,
  resetClipSpeed,
  setItemsReversed,
  addFreezeFrame,
  createPrecomposition,
  dissolvePrecomposition,
  deleteCompositions,
  promoteComposition,
  reorderTracks,
  manageTrackGroup,
] as const
