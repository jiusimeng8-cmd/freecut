import type { TimelineItem } from '@/types/timeline'
import { useItemsStore } from '../items-store'
import { useTransitionsStore } from '../transitions-store'

export interface SplitResultEntry {
  originalId: string
  originalLinkedGroupId: string | undefined
  result: {
    leftItem: TimelineItem
    rightItem: TimelineItem
  }
}

interface SplitBookkeepingOptions {
  unsplitLinkedItems: TimelineItem[]
  splitFrame: number
}

function hasAudioCoverageForVideo(
  video: TimelineItem,
  unsplitLinkedItems: TimelineItem[],
): boolean {
  if (video.type !== 'video' || !video.mediaId) {
    return false
  }

  const videoEnd = video.from + video.durationInFrames
  const videoSourceStart = video.sourceStart ?? null
  const videoSourceEnd = video.sourceEnd ?? null

  return unsplitLinkedItems.some((item) => {
    if (item.type !== 'audio' || item.mediaId !== video.mediaId) {
      return false
    }

    const sameLineage =
      (video.originId !== undefined && item.originId === video.originId) ||
      (video.originId === undefined && item.originId === undefined)
    if (!sameLineage) {
      return false
    }

    const timelineCovered = item.from <= video.from && item.from + item.durationInFrames >= videoEnd
    const sourceCovered =
      videoSourceStart !== null &&
      videoSourceEnd !== null &&
      item.sourceStart !== undefined &&
      item.sourceEnd !== undefined &&
      item.sourceStart <= videoSourceStart &&
      item.sourceEnd >= videoSourceEnd

    return timelineCovered || sourceCovered
  })
}

function remapTransitionsAfterSplit(splitResults: SplitResultEntry[]): void {
  if (splitResults.length === 0) {
    return
  }

  const splitRightByOriginalId = new Map(
    splitResults.map((entry) => [entry.originalId, entry.result.rightItem.id]),
  )

  const updatedTransitions = useTransitionsStore.getState().transitions.map((transition) => {
    const leftReplacementId = splitRightByOriginalId.get(transition.leftClipId)
    if (leftReplacementId) {
      return { ...transition, leftClipId: leftReplacementId }
    }
    if (splitRightByOriginalId.has(transition.rightClipId)) {
      return transition
    }
    return transition
  })

  useTransitionsStore.getState().setTransitions(updatedTransitions)
}

function relinkSplitSegments(
  splitResults: SplitResultEntry[],
  options?: SplitBookkeepingOptions,
): void {
  const linkedSplitResults = splitResults.filter((entry) => !!entry.originalLinkedGroupId)
  if (linkedSplitResults.length === 0) {
    return
  }

  const originalLinkedGroupIds = new Set(
    linkedSplitResults
      .map((entry) => entry.originalLinkedGroupId)
      .filter((groupId): groupId is string => !!groupId),
  )
  const unsplitLinkedItems =
    options?.unsplitLinkedItems.filter(
      (item) => !!item.linkedGroupId && originalLinkedGroupIds.has(item.linkedGroupId),
    ) ?? []
  const itemsStore = useItemsStore.getState()
  const keepLinkedGroups = linkedSplitResults.length > 1 || unsplitLinkedItems.length > 0
  const leftLinkedGroupId = keepLinkedGroups ? crypto.randomUUID() : undefined
  const rightLinkedGroupId = keepLinkedGroups ? crypto.randomUUID() : undefined
  const rightItemIdByOriginalId = new Map(
    splitResults.map((entry) => [entry.originalId, entry.result.rightItem.id]),
  )

  for (const entry of linkedSplitResults) {
    itemsStore._updateItem(entry.result.leftItem.id, { linkedGroupId: leftLinkedGroupId })
    itemsStore._updateItem(entry.result.rightItem.id, {
      linkedGroupId: rightLinkedGroupId,
      ...(hasAudioCoverageForVideo(entry.result.rightItem, unsplitLinkedItems) && {
        embeddedAudioMuted: true,
      }),
    })
  }

  if (!options || !leftLinkedGroupId || !rightLinkedGroupId) {
    return
  }

  for (const item of unsplitLinkedItems) {
    // A segment crossing the cut stays with the left media group for this split.
    const belongsToLeft = item.from < options.splitFrame
    const linkedGroupId = belongsToLeft ? leftLinkedGroupId : rightLinkedGroupId
    if (!belongsToLeft && item.type === 'subtitle' && 'clipId' in item.source) {
      const rightClipId = rightItemIdByOriginalId.get(item.source.clipId)
      itemsStore._updateItem(item.id, {
        linkedGroupId,
        ...(rightClipId ? { source: { ...item.source, clipId: rightClipId } } : {}),
      } as Partial<TimelineItem>)
      continue
    }
    if (!belongsToLeft && item.type === 'text' && item.captionSource) {
      const rightClipId = rightItemIdByOriginalId.get(item.captionSource.clipId)
      itemsStore._updateItem(item.id, {
        linkedGroupId,
        ...(rightClipId ? { captionSource: { ...item.captionSource, clipId: rightClipId } } : {}),
      } as Partial<TimelineItem>)
      continue
    }
    itemsStore._updateItem(item.id, { linkedGroupId })
  }
}

export function applySplitBookkeeping(
  splitResults: SplitResultEntry[],
  options?: SplitBookkeepingOptions,
): void {
  if (splitResults.length === 0) {
    return
  }

  remapTransitionsAfterSplit(splitResults)
  relinkSplitSegments(splitResults, options)
}
