const TOOL_CAPABILITY_MANIFEST = {
  appRuntime: [
    'read_app_runtime',
    'read_background_tasks',
    'manage_background_task',
  ],
  diagnostics: ['read_diagnostics', 'export_diagnostics'],
  discovery: [
    'find_clips',
    'search_transcript',
    'select_clips',
    'seek_to',
    'add_title',
    'import_local_media',
    'generate_captions',
    'split',
    'delete_clips',
    'set_speed',
    'set_volume',
    'trim_clip',
    'add_transition',
    'remove_silence',
    'remove_fillers',
  ],
  read: [
    'read_project',
    'read_timeline',
    'read_media',
    'read_transcript',
    'read_subtitles',
    'read_history',
    'list_sequences',
    'list_compositions',
    'list_effects',
    'inspect_timeline_integrity',
  ],
  project: [
    'list_projects',
    'create_project',
    'open_project',
    'open_projects',
    'update_project',
    'duplicate_project',
    'trash_project',
    'restore_project',
    'delete_project_forever',
    'empty_project_trash',
  ],
  projectTransfer: [
    'export_project_snapshot',
    'import_project_snapshot',
    'export_project_bundle',
    'import_project_bundle',
  ],
  workspace: [
    'read_workspace',
    'add_workspace',
    'switch_workspace',
    'reconnect_workspace',
    'remove_workspace',
  ],
  settings: [
    'read_settings',
    'update_settings',
    'manage_hotkey',
    'transfer_hotkeys',
    'reset_hotkeys',
    'reset_settings',
  ],
  storage: [
    'read_storage',
    'get_workspace_artifact',
    'delete_workspace_artifact',
    'manage_project_storage',
  ],
  legacyStorage: ['read_legacy_storage', 'manage_legacy_storage'],
  timeline: [
    'save_project',
    'undo',
    'redo',
    'create_sequence',
    'switch_sequence',
    'rename_sequence',
    'close_sequence',
    'create_track',
    'update_track',
    'delete_track',
    'move_clips',
    'duplicate_clips',
    'delete_items',
    'close_gap',
    'set_in_out',
    'manage_marker',
  ],
  advancedTimeline: [
    'manage_item_links',
    'join_items',
    'slip_clip',
    'slide_clip',
    'rolling_trim',
    'push_timeline',
    'reset_clip_speed',
    'set_items_reversed',
    'insert_freeze_frame',
    'create_precomp',
    'dissolve_precomp',
    'delete_compositions',
    'open_composition_tab',
    'reorder_tracks',
    'manage_track_group',
  ],
  sourceLayout: [
    'source_edit',
    'apply_bento_layout',
    'manage_bento_preset',
    'align_items',
    'place_composition',
  ],
  media: ['place_media', 'import_media_url'],
  mediaManagement: [
    'import_media_files',
    'delete_media',
    'scan_media_health',
    'relink_media',
    'relink_orphaned_clip',
    'manage_media_proxy',
    'transcribe_media',
    'delete_transcript',
  ],
  mediaProcessing: [
    'manage_media_interpolation',
    'manage_media_upscale',
    'read_embedded_subtitles',
    'insert_embedded_subtitles',
  ],
  sceneMedia: [
    'search_scenes',
    'detect_and_split_scenes',
    'attach_subtitle_file',
    'consolidate_subtitles',
    'focus_media',
  ],
  mediaRelink: [
    'set_project_media_folder',
    'relink_media_folder',
    'request_media_permissions',
  ],
  color: [
    'manage_effect_preset',
    'manage_color_grade_clipboard',
    'import_cube_lut',
    'balance_color',
  ],
  editorState: [
    'manage_voiceover_recording',
    'set_editing_behavior',
    'set_preview_state',
  ],
  animationLottie: [
    'bake_motion_to_keyframes',
    'manage_animation_preset',
    'set_auto_keyframe',
    'manage_easing_preset',
    'inspect_lottie',
    'search_lottie_catalog',
    'import_lottie_catalog_item',
  ],
  creative: [
    'add_text',
    'add_shape',
    'add_adjustment_layer',
    'set_transform',
    'update_subtitle',
    'style_subtitles',
    'apply_effect',
    'set_keyframes',
    'set_transition',
    'set_audio',
    'set_master_audio',
  ],
  textAndCaptions: [
    'edit_subtitle_cues',
    'manage_transcript_captions',
    'edit_text',
    'list_text_style_presets',
    'apply_text_style_preset',
  ],
  animation: [
    'list_animation_capabilities',
    'set_visual_compositing',
    'set_shape_properties',
    'set_lottie_properties',
    'apply_motion_preset',
    'manage_motion_modifier',
    'manage_text_motion',
  ],
  frameInspection: ['capture_frame', 'inspect_frame', 'inspect_frames'],
  export: [
    'check_export',
    'enqueue_export',
    'enqueue_segmented_export',
    'read_export_jobs',
    'manage_export_job',
    'set_export_queue_paused',
    'clear_export_jobs',
    'read_exports',
    'get_export_artifact',
    'delete_export',
    'export_subtitles',
  ],
} as const

export type ToolCapabilityCategory = keyof typeof TOOL_CAPABILITY_MANIFEST
export type ToolCapabilityGroup =
  | 'application'
  | 'project'
  | 'editing'
  | 'media'
  | 'creative'
  | 'diagnostics'
  | 'delivery'

const TOOL_CATEGORY_METADATA: Record<
  ToolCapabilityCategory,
  { title: string; group: ToolCapabilityGroup }
> = {
  appRuntime: { title: 'Application runtime', group: 'application' },
  diagnostics: { title: 'Logs and diagnostics', group: 'diagnostics' },
  discovery: { title: 'Editing discovery', group: 'editing' },
  read: { title: 'Project inspection', group: 'diagnostics' },
  project: { title: 'Projects', group: 'project' },
  projectTransfer: { title: 'Project transfer', group: 'project' },
  workspace: { title: 'Workspaces', group: 'project' },
  settings: { title: 'Application settings', group: 'application' },
  storage: { title: 'Workspace storage', group: 'project' },
  legacyStorage: { title: 'Legacy storage', group: 'project' },
  timeline: { title: 'Timeline editing', group: 'editing' },
  advancedTimeline: { title: 'Advanced timeline editing', group: 'editing' },
  sourceLayout: { title: 'Source editing and layouts', group: 'editing' },
  media: { title: 'Media placement', group: 'media' },
  mediaManagement: { title: 'Media management', group: 'media' },
  mediaProcessing: { title: 'Media processing', group: 'media' },
  sceneMedia: { title: 'Scene media', group: 'media' },
  mediaRelink: { title: 'Media relinking', group: 'media' },
  color: { title: 'Color grading', group: 'creative' },
  editorState: { title: 'Editor state', group: 'application' },
  animationLottie: { title: 'Lottie animation', group: 'creative' },
  creative: { title: 'Creative editing', group: 'creative' },
  textAndCaptions: { title: 'Text and captions', group: 'creative' },
  animation: { title: 'Animation', group: 'creative' },
  frameInspection: { title: 'Frame inspection', group: 'diagnostics' },
  export: { title: 'Export and delivery', group: 'delivery' },
}

const TOOL_CATEGORY_BY_NAME = new Map<string, ToolCapabilityCategory>(
  Object.entries(TOOL_CAPABILITY_MANIFEST).flatMap(([category, names]) =>
    names.map((name) => [name, category as ToolCapabilityCategory]),
  ),
)

function getToolCapabilityCategory(
  name: string,
): ToolCapabilityCategory | undefined {
  return TOOL_CATEGORY_BY_NAME.get(name)
}

export function getToolCapabilityMetadata(name: string):
  | {
      id: ToolCapabilityCategory
      title: string
      group: ToolCapabilityGroup
    }
  | undefined {
  const id = getToolCapabilityCategory(name)
  return id ? { id, ...TOOL_CATEGORY_METADATA[id] } : undefined
}

export function listToolCapabilityCategories() {
  return Object.entries(TOOL_CAPABILITY_MANIFEST).map(([id, tools]) => {
    const category = id as ToolCapabilityCategory
    return {
      id: category,
      ...TOOL_CATEGORY_METADATA[category],
      tools: [...tools],
    }
  })
}

export const REQUIRED_TOOL_NAMES = Object.values(TOOL_CAPABILITY_MANIFEST).flat()
