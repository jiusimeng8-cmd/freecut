/**
 * Timeline contract consumed by editor feature adapters.
 */

export type { TimelineState, TimelineActions } from '../types'
export { useTimelineStore } from '../stores/timeline-store'
export { useTimelineSettingsStore } from '../stores/timeline-settings-store'
export { useItemsStore } from '../stores/items-store'
export { useTransitionsStore } from '../stores/transitions-store'
export { useKeyframesStore } from '../stores/keyframes-store'
export { useCompositionsStore } from '../stores/compositions-store'
export { useSequencesStore } from '../stores/sequences-store'
export { useCompositionNavigationStore } from '../stores/composition-navigation-store'
export { useTimelineCommandStore } from '../stores/timeline-command-store'
export { useBentoPresetsStore } from '../stores/bento-presets-store'
export { useBentoLayoutDialogStore } from '../components/bento-layout-dialog-store'
export { useReverseConformDialogStore } from '../stores/reverse-conform-dialog-store'
export { useSilenceRemovalDialogStore } from '../stores/silence-removal-dialog-store'
export { useFillerRemovalDialogStore } from '../stores/filler-removal-dialog-store'
export {
  analyzeSilenceForItems,
  normalizeSilenceRemovalSettings,
} from '../utils/silence-removal-preview'
export type { SilenceRemovalSettings } from '../utils/silence-removal-preview'
export { captureSnapshot } from '../stores/commands/snapshot'
export { execute as executeTimelineCommand } from '../stores/actions/shared'
export { canAddKeyframeAtFrame } from '../stores/actions/shared'
export { Timeline } from '../components/timeline'
export { KeyframeGraphPanel } from '../components/keyframe-graph-panel'
export { TranscriptEditorPanel } from '../components/transcript-editor/transcript-editor-panel'
export { useTimelineShortcuts } from '../hooks/use-timeline-shortcuts'
export { useTransitionBreakageNotifications } from '../hooks/use-transition-breakage-notifications'
export { useFilmstrip } from '../hooks/use-filmstrip'
export type { FilmstripFrame } from '../hooks/use-filmstrip'
export { findNearestAvailableSpace } from '../utils/collision-utils'
export { detectOverlappingItems } from '../utils/collision-utils'
export { getMaxTransitionDurationForHandles } from '../utils/transition-utils'
export { resolveTransitionTargetFromSelection } from '../utils/transition-targets'
export {
  createDefaultAdjustmentItem,
  createDefaultShapeItem,
  createTextTemplateItem,
  getDefaultGeneratedLayerDurationInFrames,
} from '../utils/generated-layer-items'
export { findCompatibleTrackForItemType } from '../utils/track-item-compatibility'
export { createOverlayLayerTrack } from '../utils/new-track-zone-media'
export { createClassicTrack, getTrackKind } from '../utils/classic-tracks'
export { buildDroppedMediaEntriesFromImportedMedia } from '../utils/drop-execution'
export {
  buildDroppedMediaTimelineItems,
  getDroppedMediaDurationInFrames,
} from '../utils/dropped-media'
export {
  buildDroppedCompositionTimelineItems,
  compositionHasOwnedAudio,
} from '../utils/dropped-composition'
export { planTrackMediaDropPlacements } from '../utils/track-media-drop'
export { resolveSourceEditTrackTargets } from '../utils/source-edit-targeting'
export { getDefaultActiveTrackId } from '../utils/default-active-track'
export { resolveEffectiveTrackStates } from '../utils/group-utils'
export { wouldCreateCompositionCycle } from '../utils/composition-graph'
export {
  computeBentoLayout,
  computeLayout,
} from '../utils/bento-layout'
export type {
  BentoLayoutItem,
  LayoutConfig,
  LayoutPresetType,
} from '../utils/bento-layout'
export {
  linkItems,
  reverseItems,
  trackPushItems,
  unlinkItems,
} from '../stores/actions/item-actions'
export { applyAnimationPreset } from '../stores/actions/preset-actions'
export {
  applyAutoKeyframeOperations,
  applyMotionPresetKeyframes,
} from '../stores/actions/keyframe-actions'
export type { MotionPresetClear } from '../stores/actions/keyframe-actions'
export {
  applyBentoLayout,
  updateItemsTransformMap,
} from '../stores/actions/transform-actions'
export {
  applyMotionModifierToItems,
  updateMotionModifiersLive,
  beginMotionModifierEdit,
  commitMotionModifierEdit,
  removeMotionModifierFromItems,
  bakeMotionToKeyframes,
} from '../stores/actions/motion-modifier-actions'
export {
  applyTextMotionEffect,
  updateTextMotionLive,
  beginTextMotionEdit,
  commitTextMotionEdit,
  removeTextMotionEffect,
} from '../stores/actions/text-motion-actions'
export { captureAnimationFromItem, getPresetCompatibility } from '../deps/keyframe-editors'
export {
  insertFreezeFrame,
  joinItems,
  rateStretchItemWithoutHistory,
  resetSpeedWithRipple,
  rollingTrimItems,
  slideItem,
  slipItem,
} from '../stores/actions/item-edit-actions'
export { setInOutPointsWithoutHistory } from '../stores/actions/marker-actions'
export {
  performInsertEdit,
  performOverwriteEdit,
} from '../stores/actions/source-edit-actions'
export { timelineToSourceFrames, sourceToTimelineFrames } from '../utils/source-calculations'
export { searchTimelineTranscript } from '../utils/transcript-search'
export { createScrubThrottleState, shouldCommitScrubFrame } from '../utils/scrub-throttle'
export { initTransitionChainSubscription } from '../stores/transition-chain-store'
export {
  closeSequenceTab,
  createPreComp,
  createSequence,
  deleteCompoundClips,
  dissolvePreComp,
  getCompoundClipDeletionImpact,
  openCompositionAsTab,
  renameCompoundClip,
} from '../stores/actions/composition-actions'
export {
  getActiveExportSequenceId,
  getExportableSequence,
  listExportableSequences,
} from '../stores/actions/export-snapshot'
export {
  getMediaDeletionImpact,
  removeProjectItems,
} from '../stores/actions/project-item-actions'
export {
  copyGradeFromItem,
  pasteGradeToItems,
} from '../utils/grade-clipboard-ops'
export {
  cancelMicRecording,
  cancelPendingMicRecording,
  isMicRecordingSupported,
  pauseMicRecording,
  refreshMicDevices,
  resumeMicRecording,
  startMicRecording,
  stopMicRecording,
} from '../services/mic-recording-controller'

export const importGifFrameCache = () => import('../services/gif-frame-cache')
export const importFilmstripCache = () => import('../services/filmstrip-cache')
export const importWaveformCache = () => import('../services/waveform-cache')
export const importBentoLayoutDialog = () => import('../components/bento-layout-dialog')
export const importReverseConformDialog = () => import('../components/reverse-conform-dialog')
export const importSilenceRemovalDialog = () => import('../components/silence-removal-dialog')
export const importFillerRemovalDialog = () => import('../components/filler-removal-dialog')
