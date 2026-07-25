import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { i18n } from '@/i18n'
import type { TimelineItem as TimelineItemType } from '@/types/timeline'
import type { AnimatableProperty } from '@/types/keyframe'
import { useSelectionStore } from '@/shared/state/selection'
import { usePlaybackStore } from '@/shared/state/playback'
import { useClearKeyframesDialogStore } from '@/shared/state/clear-keyframes-dialog'
import { useMediaLibraryStore } from '@/features/timeline/deps/media-library-store'
import { useTimelineStore } from '../../stores/timeline-store'
import { useItemsStore } from '../../stores/items-store'
import {
  insertFreezeFrame,
  linkItems,
  reverseItems,
  splitItemAtFrames,
  unlinkItems,
} from '../../stores/actions/item-actions'
import {
  createPreComp,
  dissolvePreComp,
  openComposition,
} from '../../stores/actions/composition-actions'
import {
  type TimelineItemOverlay,
  useTimelineItemOverlayStore,
} from '../../stores/timeline-item-overlay-store'
import { useSilenceRemovalDialogStore } from '../../stores/silence-removal-dialog-store'
import { useFillerRemovalDialogStore } from '../../stores/filler-removal-dialog-store'
import { canJoinMultipleItems } from '../../utils/clip-utils'
import { canLinkSelection, hasLinkedItems } from '../../utils/linked-items'
import { importSceneDetection } from '../../deps/analysis'
import { resolveMediaUrl } from '../../deps/media-library-resolver'
import { useBentoLayoutDialogStore } from '../bento-layout-dialog-store'
import { createLogger } from '@/shared/logging/logger'
import { saveScenes } from '@/infrastructure/storage/workspace-fs/scenes'
import {
  analyzeFillerWordsForItems,
  applyFillerPreviewOverlays,
  DEFAULT_FILLER_REMOVAL_SETTINGS,
} from '../../utils/filler-word-removal-preview'

const logger = createLogger('UseTimelineItemActions')

const SCENE_DETECTION_OVERLAY_ID = 'scene-detection'

interface UseTimelineItemActionsParams {
  item: TimelineItemType
  isBroken: boolean
  leftNeighbor: TimelineItemType | null
  rightNeighbor: TimelineItemType | null
  segmentOverlays: readonly TimelineItemOverlay[]
}

export function useTimelineItemActions({
  item,
  isBroken,
  leftNeighbor,
  rightNeighbor,
  segmentOverlays,
}: UseTimelineItemActionsParams) {
  const getCanJoinSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length < 2) {
      return false
    }

    const items = useTimelineStore.getState().items
    const selectedItems = selectedItemIds
      .map((id) => items.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
    return canJoinMultipleItems(selectedItems)
  }, [])

  const getCanLinkSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length < 2) {
      return false
    }

    const items = useTimelineStore.getState().items
    return canLinkSelection(items, selectedItemIds)
  }, [])

  const getCanUnlinkSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length === 0) {
      return false
    }

    const items = useTimelineStore.getState().items
    return selectedItemIds.some((id) => hasLinkedItems(items, id))
  }, [])

  const handleJoinSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length >= 2) {
      const itemById = useItemsStore.getState().itemById
      const selectedItems = selectedItemIds
        .map((id) => itemById[id])
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
      if (canJoinMultipleItems(selectedItems)) {
        useTimelineStore.getState().joinItems(selectedItemIds)
      }
    }
  }, [])

  const handleJoinLeft = useCallback(() => {
    if (leftNeighbor) {
      useTimelineStore.getState().joinItems([leftNeighbor.id, item.id])
    }
  }, [leftNeighbor, item.id])

  const handleJoinRight = useCallback(() => {
    if (rightNeighbor) {
      useTimelineStore.getState().joinItems([item.id, rightNeighbor.id])
    }
  }, [rightNeighbor, item.id])

  const handleDelete = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length > 0) {
      useTimelineStore.getState().removeItems(selectedItemIds)
    }
  }, [])

  const handleRippleDelete = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length > 0) {
      useTimelineStore.getState().rippleDeleteItems(selectedItemIds)
    }
  }, [])

  const handleLinkSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    void linkItems(selectedItemIds)
  }, [])

  const handleUnlinkSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    unlinkItems(selectedItemIds)
  }, [])

  const handleReverseSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    reverseItems(selectedItemIds.length > 0 ? selectedItemIds : [item.id])
  }, [item.id])

  const handleClearAllKeyframes = useCallback(() => {
    useClearKeyframesDialogStore.getState().openClearAll([item.id])
  }, [item.id])

  const handleClearPropertyKeyframes = useCallback(
    (property: AnimatableProperty) => {
      useClearKeyframesDialogStore.getState().openClearProperty([item.id], property)
    },
    [item.id],
  )

  const handleBentoLayout = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length < 2) {
      return
    }
    useBentoLayoutDialogStore.getState().open(selectedItemIds)
  }, [])

  const handleFreezeFrame = useCallback(() => {
    if (item.type !== 'video') {
      return
    }
    const { currentFrame } = usePlaybackStore.getState()
    void insertFreezeFrame(item.id, currentFrame)
  }, [item.id, item.type])

  const isSceneDetectionActive = segmentOverlays.some(
    (overlay) => overlay.id === SCENE_DETECTION_OVERLAY_ID,
  )

  const isCompositionItem =
    item.type === 'composition' || (item.type === 'audio' && !!item.compositionId)
  const sourceStart = 'sourceStart' in item ? item.sourceStart : undefined
  const clipFrom = item.from

  const handleCreatePreComp = useCallback(() => {
    // Capture selection synchronously - context menu close may clear it before the dynamic import resolves.
    const ids = useSelectionStore.getState().selectedItemIds
    createPreComp(undefined, ids)
  }, [])

  const compositionId = item.compositionId
  const itemLabel = item.label
  const handleEnterComposition = useCallback(() => {
    if (!isCompositionItem || !compositionId) {
      return
    }

    openComposition(compositionId, itemLabel, item.id)
  }, [isCompositionItem, compositionId, itemLabel, item.id])

  const handleDissolveComposition = useCallback(() => {
    if (!isCompositionItem) {
      return
    }

    dissolvePreComp(item.id)
  }, [isCompositionItem, item.id])

  const sceneDetectionAbortRef = useRef<AbortController | null>(null)
  const [isRemovingFillers, setIsRemovingFillers] = useState(false)

  useEffect(() => {
    return () => {
      sceneDetectionAbortRef.current?.abort()
    }
  }, [])

  const handleDetectScenes = useCallback(
    (method: 'histogram' | 'optical-flow') => {
      if (item.type !== 'video' || !item.mediaId || isBroken) {
        return
      }

      const mediaId = item.mediaId
      const clipId = item.id
      const overlayStore = useTimelineItemOverlayStore.getState()

      const run = async () => {
        sceneDetectionAbortRef.current?.abort()
        const abortController = new AbortController()
        sceneDetectionAbortRef.current = abortController
        let video: HTMLVideoElement | null = null

        try {
          overlayStore.upsertOverlay(clipId, {
            id: SCENE_DETECTION_OVERLAY_ID,
            label: i18n.t('timeline.sceneDetection.detectingScenes'),
            progress: 0,
            tone: 'info',
          })

          const url = await resolveMediaUrl(mediaId)
          video = document.createElement('video')
          video.src = url
          video.muted = true
          video.preload = 'auto'

          await new Promise<void>((resolve, reject) => {
            if (abortController.signal.aborted) {
              reject(new DOMException('Aborted', 'AbortError'))
              return
            }
            const onAbort = () => {
              reject(new DOMException('Aborted', 'AbortError'))
            }
            abortController.signal.addEventListener('abort', onAbort, { once: true })
            video!.onloadedmetadata = () => {
              abortController.signal.removeEventListener('abort', onAbort)
              resolve()
            }
            video!.onerror = () => {
              abortController.signal.removeEventListener('abort', onAbort)
              reject(new Error('Failed to load video for scene detection'))
            }
          })

          const currentFps = useTimelineStore.getState().fps
          const media = useMediaLibraryStore.getState().mediaById[mediaId]
          const mediaFps = media?.fps ?? currentFps
          const { detectScenes } = await importSceneDetection()
          const cuts = await detectScenes(video, currentFps, {
            method,
            mediaId,
            signal: abortController.signal,
            onProgress: (progress) => {
              useTimelineItemOverlayStore.getState().upsertOverlay(clipId, {
                id: SCENE_DETECTION_OVERLAY_ID,
                label: `Analyzing ${method === 'histogram' ? 'frames' : 'motion'} (${progress.sceneCuts} candidates)`,
                progress: progress.percent,
                tone: 'info',
              })
            },
          })

          // Persist scene cuts to the workspace so the next session/window
          // doesn't need to recompute. Fire-and-forget — UX proceeds regardless.
          if (cuts.length > 0) {
            void saveScenes({
              mediaId,
              service:
                method === 'histogram' ? 'scene-detect-histogram' : 'scene-detect-optical-flow',
              model: method,
              method,
              sampleIntervalMs: method === 'histogram' ? 250 : 500,
              fps: mediaFps,
              cuts,
            }).catch((error) => logger.warn('Failed to persist scene cuts', error))
          }

          if (cuts.length === 0) {
            toast.info(i18n.t('timeline.sceneDetection.noScenesDetected'))
            return
          }

          const clipDuration = item.durationInFrames
          // sourceStart is in source-native FPS; convert to project FPS for consistent math
          const sourceStartSeconds = (sourceStart ?? 0) / mediaFps
          const sourceStartInProjectFrames = Math.round(sourceStartSeconds * currentFps)
          const splitFrames = cuts
            .map((cut) => cut.frame - sourceStartInProjectFrames)
            .filter((frame) => frame > 0 && frame < clipDuration)
            .map((frame) => frame + clipFrom)

          if (splitFrames.length === 0) {
            toast.info(i18n.t('timeline.sceneDetection.noScenesWithinBounds'))
            return
          }

          const splitCount = splitItemAtFrames(clipId, splitFrames)

          if (splitCount > 0) {
            toast.success(i18n.t('timeline.sceneDetection.splitAtScenes', { count: splitCount }))
          } else {
            toast.info(i18n.t('timeline.sceneDetection.noValidSplitPoints'))
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return
          }
          if (error instanceof Error && error.message.includes('WebGPU')) {
            toast.error(i18n.t('timeline.sceneDetection.requiresWebGpu'))
          } else {
            toast.error(i18n.t('timeline.sceneDetection.failed'))
          }
        } finally {
          if (video) {
            video.onloadedmetadata = null
            video.onerror = null
            video.src = ''
          }
          // Only remove overlay if this run still owns the controller
          if (sceneDetectionAbortRef.current === abortController) {
            useTimelineItemOverlayStore.getState().removeOverlay(clipId, SCENE_DETECTION_OVERLAY_ID)
          }
        }
      }

      void run()
    },
    [clipFrom, isBroken, item.durationInFrames, item.id, item.mediaId, item.type, sourceStart],
  )

  const handleRemoveSilence = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    const targetIds = selectedItemIds.length > 0 ? selectedItemIds : [item.id]
    const targetItems = targetIds
      .map((id) => useItemsStore.getState().itemById[id])
      .filter(
        (candidate): candidate is TimelineItemType =>
          candidate !== undefined &&
          (candidate.type === 'video' || candidate.type === 'audio') &&
          !!candidate.mediaId,
      )

    if (targetItems.length === 0) {
      toast.info(i18n.t('timeline.itemActions.selectAvClipFirst'))
      return
    }

    useSilenceRemovalDialogStore.getState().open({
      itemIds: targetItems.map((target) => target.id),
    })
  }, [item.id])

  const handleRemoveFillers = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    const targetIds = selectedItemIds.length > 0 ? selectedItemIds : [item.id]
    const targetItems = targetIds
      .map((id) => useItemsStore.getState().itemById[id])
      .filter(
        (candidate): candidate is TimelineItemType =>
          candidate !== undefined &&
          (candidate.type === 'video' || candidate.type === 'audio') &&
          !!candidate.mediaId,
      )

    if (targetItems.length === 0) {
      toast.info('Select an audio or video clip first')
      return
    }

    const run = async () => {
      setIsRemovingFillers(true)
      try {
        const targetItemIds = targetItems.map((target) => target.id)
        const rangesByMediaId = await analyzeFillerWordsForItems(
          targetItemIds,
          DEFAULT_FILLER_REMOVAL_SETTINGS,
        )
        const summary = applyFillerPreviewOverlays(targetItemIds, rangesByMediaId)

        if (summary.rangeCount === 0) {
          toast.info(i18n.t('timeline.fillerRemoval.noRemovableDetectedShort'))
          return
        }

        useFillerRemovalDialogStore.getState().open({
          itemIds: targetItemIds,
          settings: DEFAULT_FILLER_REMOVAL_SETTINGS,
          rangesByMediaId,
          summary,
        })
      } catch (error) {
        logger.warn('Remove filler words failed', error)
        toast.error(
          error instanceof Error
            ? error.message
            : i18n.t('timeline.fillerRemoval.toastPreviewFailed'),
        )
      } finally {
        setIsRemovingFillers(false)
      }
    }

    void run()
  }, [item.id])

  return {
    getCanJoinSelected,
    getCanLinkSelected,
    getCanUnlinkSelected,
    isSceneDetectionActive,
    isRemovingFillers,
    isCompositionItem,
    handleJoinSelected,
    handleJoinLeft,
    handleJoinRight,
    handleDelete,
    handleRippleDelete,
    handleLinkSelected,
    handleUnlinkSelected,
    handleReverseSelected,
    handleClearAllKeyframes,
    handleClearPropertyKeyframes,
    handleBentoLayout,
    handleFreezeFrame,
    handleCreatePreComp,
    handleEnterComposition,
    handleDissolveComposition,
    handleDetectScenes,
    handleRemoveSilence,
    handleRemoveFillers,
  }
}
