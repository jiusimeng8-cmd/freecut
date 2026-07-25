/**
 * Adapter exports for timeline utility dependencies.
 * Editor modules should import timeline utility helpers from here.
 */

export {
  createClassicTrack,
  createDefaultAdjustmentItem,
  buildDroppedMediaEntriesFromImportedMedia,
  buildDroppedMediaTimelineItems,
  createScrubThrottleState,
  shouldCommitScrubFrame,
  createDefaultShapeItem,
  createOverlayLayerTrack,
  createTextTemplateItem,
  findCompatibleTrackForItemType,
  findNearestAvailableSpace,
  getDefaultActiveTrackId,
  getDefaultGeneratedLayerDurationInFrames,
  getDroppedMediaDurationInFrames,
  getTrackKind,
  planTrackMediaDropPlacements,
  resolveSourceEditTrackTargets,
  resolveEffectiveTrackStates,
  getMaxTransitionDurationForHandles,
  resolveTransitionTargetFromSelection,
  searchTimelineTranscript,
  timelineToSourceFrames,
  sourceToTimelineFrames,
} from './timeline-contract'
