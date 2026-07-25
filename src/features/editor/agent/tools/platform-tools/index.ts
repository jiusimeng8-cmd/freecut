import { READ_PLATFORM_TOOLS } from './read-tools'
import { TIMELINE_PLATFORM_TOOLS } from './timeline-tools'
import { ADVANCED_TIMELINE_PLATFORM_TOOLS } from './advanced-timeline-tools'
import { MEDIA_PLATFORM_TOOLS } from './media-tools'
import { MEDIA_MANAGEMENT_PLATFORM_TOOLS } from './media-management-tools'
import { CREATIVE_PLATFORM_TOOLS } from './creative-tools'
import { ADVANCED_CREATIVE_PLATFORM_TOOLS } from './advanced-creative-tools'
import { EXPORT_PLATFORM_TOOLS } from './export-tools'
import { PROJECT_PLATFORM_TOOLS } from './project-tools'
import { PROJECT_TRANSFER_PLATFORM_TOOLS } from './project-transfer-tools'
import { TEXT_CAPTION_PLATFORM_TOOLS } from './text-caption-tools'
import { FRAME_PLATFORM_TOOLS } from './frame-tools'
import { SETTINGS_PLATFORM_TOOLS } from './settings-tools'
import { WORKSPACE_PLATFORM_TOOLS } from './workspace-tools'
import { STORAGE_PLATFORM_TOOLS } from './storage-tools'
import { LEGACY_STORAGE_PLATFORM_TOOLS } from './legacy-storage-tools'
import { MEDIA_PROCESSING_PLATFORM_TOOLS } from './media-processing-tools'
import { SCENE_MEDIA_PLATFORM_TOOLS } from './scene-media-tools'
import { MEDIA_RELINK_PLATFORM_TOOLS } from './media-relink-tools'
import { COLOR_PLATFORM_TOOLS } from './color-tools'
import { EDITOR_STATE_PLATFORM_TOOLS } from './editor-state-tools'
import { ANIMATION_LOTTIE_PLATFORM_TOOLS } from './animation-lottie-tools'
import { SOURCE_LAYOUT_PLATFORM_TOOLS } from './source-layout-tools'
import { APPLICATION_PLATFORM_TOOLS } from './application-tools'

export const PLATFORM_TOOLS = [
  ...APPLICATION_PLATFORM_TOOLS,
  ...READ_PLATFORM_TOOLS,
  ...WORKSPACE_PLATFORM_TOOLS,
  ...PROJECT_PLATFORM_TOOLS,
  ...PROJECT_TRANSFER_PLATFORM_TOOLS,
  ...SETTINGS_PLATFORM_TOOLS,
  ...STORAGE_PLATFORM_TOOLS,
  ...LEGACY_STORAGE_PLATFORM_TOOLS,
  ...TIMELINE_PLATFORM_TOOLS,
  ...ADVANCED_TIMELINE_PLATFORM_TOOLS,
  ...SOURCE_LAYOUT_PLATFORM_TOOLS,
  ...MEDIA_PLATFORM_TOOLS,
  ...MEDIA_MANAGEMENT_PLATFORM_TOOLS,
  ...MEDIA_PROCESSING_PLATFORM_TOOLS,
  ...SCENE_MEDIA_PLATFORM_TOOLS,
  ...MEDIA_RELINK_PLATFORM_TOOLS,
  ...COLOR_PLATFORM_TOOLS,
  ...EDITOR_STATE_PLATFORM_TOOLS,
  ...ANIMATION_LOTTIE_PLATFORM_TOOLS,
  ...CREATIVE_PLATFORM_TOOLS,
  ...TEXT_CAPTION_PLATFORM_TOOLS,
  ...ADVANCED_CREATIVE_PLATFORM_TOOLS,
  ...FRAME_PLATFORM_TOOLS,
  ...EXPORT_PLATFORM_TOOLS,
] as const
