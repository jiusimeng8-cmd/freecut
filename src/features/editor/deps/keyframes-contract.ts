/**
 * Adapter exports for keyframes dependencies.
 * Editor modules should import keyframes components/utils from here.
 */

export { KeyframeToggle } from '@/features/keyframes/components/keyframe-toggle'
export { resolveAnimatedTransform } from '@/features/keyframes/utils/animated-transform-resolver'
export {
  getCropPropertyValue,
  resolveAnimatedCrop,
} from '@/features/keyframes/utils/animated-crop-resolver'
export {
  getPropertyKeyframes,
  interpolatePropertyValue,
} from '@/features/keyframes/utils/interpolation'
export { colorStringToKeyframeValue } from '@/features/keyframes/utils/color-keyframes'
export {
  getAutoKeyframeOperation,
  type AutoKeyframeOperation,
} from '@/features/keyframes/utils/auto-keyframe'
export { useAutoKeyframeStore } from '@/features/keyframes/stores/auto-keyframe-store'
export { getAnimatablePropertiesForItem } from '@/features/keyframes/utils/animatable-properties'
export {
  loadCustomPresets,
  saveCustomPresets,
} from '@/features/keyframes/components/dopesheet-editor/custom-easing-presets'
export type { EasingPreset } from '@/features/keyframes/components/dopesheet-editor/easings-dev-presets'
export {
  MOTION_PRESETS,
  MOTION_PRESET_CATEGORIES,
  getMotionPresetAnchorFrame,
  motionPresetScalesBox,
  type MotionPreset,
  type MotionPresetCategory,
  type MotionThumbnail,
} from '@/features/keyframes/utils/motion-presets'
export {
  DEFAULT_MOTION_GENERATOR_SETTINGS,
  applyMotionGeneratorSettings,
  type MotionGeneratorSettings,
} from '@/features/keyframes/utils/motion-generator'
export {
  MOTION_MODULATORS,
  type MotionModulator,
} from '@/features/keyframes/utils/motion-modulators'
export {
  createMotionModifier,
  getMotionModifierSettings,
  updateMotionModifierSettings,
} from '@/features/keyframes/utils/motion-modifier-eval'
export {
  bakeMotionModifiersToKeyframes,
  bakeAudioPulseToKeyframes,
  buildBakeMotionPlan,
} from '@/features/keyframes/utils/bake-motion'
export {
  TRIGGER_WAVE_MOTION_LAYER_LABEL,
  createAudioPulseModulation,
  buildTriggerWaveMotionLayerKeyframes,
  createTriggerWaveMotionLayerEffects,
} from '@/features/keyframes/utils/trigger-wave-motion-layer'
