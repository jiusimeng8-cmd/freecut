import { z } from 'zod'
import {
  cancelMicRecording,
  cancelPendingMicRecording,
  isMicRecordingSupported,
  pauseMicRecording,
  refreshMicDevices,
  resumeMicRecording,
  startMicRecording,
  stopMicRecording,
} from '@/features/editor/deps/mic-recording-contract'
import { useGizmoStore } from '@/features/editor/deps/preview-contract'
import { useSettingsStore } from '@/features/editor/deps/settings-contract'
import { useTimelineSettingsStore } from '@/features/editor/deps/timeline-contract'
import { useEditorStore } from '@/shared/state/editor'
import { isMicRecordingActive, useMicRecordingStore } from '@/shared/state/mic-recording-store'
import { usePlaybackStore } from '@/shared/state/playback'
import { definePlatformTool, objectSchema } from './shared'

function readVoiceoverState() {
  const recording = useMicRecordingStore.getState()
  return {
    supported: isMicRecordingSupported(),
    runtime: {
      status: recording.status,
      elapsedMs: recording.elapsedMs,
      level: recording.level,
      recordStartFrame: recording.recordStartFrame,
      error: recording.error,
      devices: recording.devices,
    },
    persisted: {
      deviceId: recording.selectedDeviceId,
      noiseSuppression: recording.noiseSuppression,
      autoGainControl: recording.autoGainControl,
      muteWhileRecording: recording.muteWhileRecording,
      syncOffsetMs: recording.syncOffsetMs,
    },
  }
}

function sameDevices(
  left: ReadonlyArray<{ deviceId: string; label: string }>,
  right: ReadonlyArray<{ deviceId: string; label: string }>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (device, index) =>
        device.deviceId === right[index]?.deviceId && device.label === right[index]?.label,
    )
  )
}

const manageVoiceoverRecordingSchema = z
  .object({
    operation: z.enum(['list_devices', 'status', 'start', 'pause', 'resume', 'stop', 'cancel']),
    deviceId: z.string().min(1).nullable().optional(),
    noiseSuppression: z.boolean().optional(),
    autoGainControl: z.boolean().optional(),
    muteWhileRecording: z.boolean().optional(),
    syncOffsetMs: z.number().min(-1000).max(1000).optional(),
  })
  .refine(
    (value) =>
      value.operation === 'start' ||
      (value.deviceId === undefined &&
        value.noiseSuppression === undefined &&
        value.autoGainControl === undefined &&
        value.muteWhileRecording === undefined &&
        value.syncOffsetMs === undefined),
    {
      message: 'Recording preferences can only be supplied with operation "start".',
      path: ['operation'],
    },
  )

const manageVoiceoverRecording = definePlatformTool({
  name: 'manage_voiceover_recording',
  handoff: true,
  title: 'Manage voiceover recording',
  description:
    'List microphone devices, inspect recorder status, or start, pause, resume, stop, and cancel a timeline-synced voiceover take. Start can update persisted capture preferences; stop uses the existing media import and timeline placement flow.',
  inputSchema: objectSchema(
    {
      operation: {
        type: 'string',
        enum: ['list_devices', 'status', 'start', 'pause', 'resume', 'stop', 'cancel'],
      },
      deviceId: {
        type: ['string', 'null'],
        description: 'Audio input device id, or null for the system default. Used by start.',
      },
      noiseSuppression: { type: 'boolean', description: 'Used by start.' },
      autoGainControl: { type: 'boolean', description: 'Used by start.' },
      muteWhileRecording: { type: 'boolean', description: 'Used by start.' },
      syncOffsetMs: {
        type: 'number',
        minimum: -1000,
        maximum: 1000,
        description: 'Timeline placement offset in milliseconds. Used by start.',
      },
    },
    ['operation'],
  ),
  schema: manageVoiceoverRecordingSchema,
  summarize: ({ operation }) => `${operation} voiceover recording`,
  execute: async (args) => {
    const before = useMicRecordingStore.getState()

    if (args.operation === 'list_devices') {
      const previousDevices = before.devices
      const previousDeviceId = before.selectedDeviceId
      await refreshMicDevices()
      const after = useMicRecordingStore.getState()
      const changed =
        previousDeviceId !== after.selectedDeviceId || !sameDevices(previousDevices, after.devices)
      return {
        ok: true,
        message: `Found ${after.devices.length} microphone device${after.devices.length === 1 ? '' : 's'}.`,
        data: readVoiceoverState(),
        changed,
      }
    }

    if (args.operation === 'status') {
      return {
        ok: true,
        message: `Voiceover recorder is ${before.status}.`,
        data: readVoiceoverState(),
        changed: false,
      }
    }

    let preferencesChanged = false
    if (args.operation === 'start') {
      if (before.status !== 'idle') {
        return {
          ok: true,
          message: `Voiceover recorder is already ${before.status}.`,
          data: readVoiceoverState(),
          changed: false,
        }
      }

      if (args.deviceId !== undefined && before.selectedDeviceId !== args.deviceId) {
        before.setSelectedDeviceId(args.deviceId)
        preferencesChanged = true
      }
      if (
        args.noiseSuppression !== undefined &&
        before.noiseSuppression !== args.noiseSuppression
      ) {
        before.setNoiseSuppression(args.noiseSuppression)
        preferencesChanged = true
      }
      if (args.autoGainControl !== undefined && before.autoGainControl !== args.autoGainControl) {
        before.setAutoGainControl(args.autoGainControl)
        preferencesChanged = true
      }
      if (
        args.muteWhileRecording !== undefined &&
        before.muteWhileRecording !== args.muteWhileRecording
      ) {
        before.setMuteWhileRecording(args.muteWhileRecording)
        preferencesChanged = true
      }
      if (args.syncOffsetMs !== undefined) {
        const syncOffsetMs = Math.round(args.syncOffsetMs)
        if (before.syncOffsetMs !== syncOffsetMs) {
          before.setSyncOffsetMs(syncOffsetMs)
          preferencesChanged = true
        }
      }

      await startMicRecording()
      const after = useMicRecordingStore.getState()
      const changed =
        preferencesChanged || before.status !== after.status || before.error !== after.error
      if (after.status !== 'recording') {
        const message = after.error ?? 'Voiceover recording did not start.'
        return {
          ok: false,
          message,
          data: readVoiceoverState(),
          error: {
            code: isMicRecordingSupported() ? 'VOICEOVER_START_FAILED' : 'VOICEOVER_UNSUPPORTED',
            message,
            retryable: isMicRecordingSupported(),
          },
          changed,
        }
      }
      return {
        ok: true,
        message: 'Started voiceover recording.',
        data: readVoiceoverState(),
        changed,
      }
    }

    if (args.operation === 'pause') {
      pauseMicRecording()
    } else if (args.operation === 'resume') {
      resumeMicRecording()
    } else if (args.operation === 'stop') {
      await stopMicRecording()
    } else if (before.status === 'requesting') {
      cancelPendingMicRecording()
    } else if (isMicRecordingActive(before.status)) {
      cancelMicRecording()
    }

    const after = useMicRecordingStore.getState()
    const changed = before.status !== after.status || before.error !== after.error

    if (args.operation === 'stop' && changed && after.error) {
      return {
        ok: false,
        message: after.error,
        data: readVoiceoverState(),
        error: {
          code: 'VOICEOVER_STOP_FAILED',
          message: after.error,
          retryable: true,
        },
        changed,
      }
    }

    const messages = {
      pause: changed ? 'Paused voiceover recording.' : `Voiceover recorder is ${after.status}.`,
      resume: changed ? 'Resumed voiceover recording.' : `Voiceover recorder is ${after.status}.`,
      stop: changed
        ? 'Stopped and saved voiceover recording.'
        : `Voiceover recorder is ${after.status}.`,
      cancel: changed ? 'Cancelled voiceover recording.' : 'No active voiceover take to cancel.',
    } as const

    return {
      ok: true,
      message: messages[args.operation],
      data: readVoiceoverState(),
      changed,
    }
  },
})

function readEditingBehavior() {
  const settings = useSettingsStore.getState()
  const timeline = useTimelineSettingsStore.getState()
  const editor = useEditorStore.getState()
  return {
    state: {
      snapEnabled: timeline.snapEnabled,
      audioSkimmingEnabled: timeline.audioSkimmingEnabled,
      linkedSelectionEnabled: editor.linkedSelectionEnabled,
    },
    persisted: {
      snapEnabled: settings.snapEnabled,
    },
    uiOnly: {
      audioSkimmingEnabled: timeline.audioSkimmingEnabled,
      linkedSelectionEnabled: editor.linkedSelectionEnabled,
    },
  }
}

const setEditingBehaviorSchema = z
  .object({
    snapEnabled: z.boolean().optional(),
    audioSkimmingEnabled: z.boolean().optional(),
    linkedSelectionEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'At least one editing behavior is required.',
  })

const setEditingBehavior = definePlatformTool({
  name: 'set_editing_behavior',
  requiresProject: false,
  title: 'Set editing behavior',
  description:
    'Set timeline snapping, audio skimming, and linked selection. Snapping updates both the live timeline and its persisted app preference; audio skimming and linked selection are runtime UI state.',
  inputSchema: objectSchema({
    snapEnabled: { type: 'boolean' },
    audioSkimmingEnabled: { type: 'boolean' },
    linkedSelectionEnabled: { type: 'boolean' },
  }),
  schema: setEditingBehaviorSchema,
  summarize: () => 'Set FreeCut editing behavior',
  execute: (updates) => {
    const settings = useSettingsStore.getState()
    const timeline = useTimelineSettingsStore.getState()
    const editor = useEditorStore.getState()
    let changed = false

    if (updates.snapEnabled !== undefined) {
      if (settings.snapEnabled !== updates.snapEnabled) {
        settings.setSetting('snapEnabled', updates.snapEnabled)
        changed = true
      }
      if (timeline.snapEnabled !== updates.snapEnabled) {
        timeline.setSnapEnabled(updates.snapEnabled)
        changed = true
      }
    }
    if (
      updates.audioSkimmingEnabled !== undefined &&
      timeline.audioSkimmingEnabled !== updates.audioSkimmingEnabled
    ) {
      timeline.setAudioSkimmingEnabled(updates.audioSkimmingEnabled)
      changed = true
    }
    if (
      updates.linkedSelectionEnabled !== undefined &&
      editor.linkedSelectionEnabled !== updates.linkedSelectionEnabled
    ) {
      editor.setLinkedSelectionEnabled(updates.linkedSelectionEnabled)
      changed = true
    }

    return {
      ok: true,
      message: changed
        ? 'Updated FreeCut editing behavior.'
        : 'FreeCut editing behavior was already up to date.',
      data: readEditingBehavior(),
      changed,
    }
  },
})

function readPreviewState() {
  const playback = usePlaybackStore.getState()
  const grade = useGizmoStore.getState()
  const fps = useTimelineSettingsStore.getState().fps
  return {
    state: {
      playback: playback.isPlaying ? 'play' : 'pause',
      currentFrame: playback.currentFrame,
      currentSeconds: playback.currentFrame / fps,
      monitorVolume: playback.volume,
      monitorMuted: playback.muted,
      useProxy: playback.useProxy,
      comparisonMode: grade.colorGradeComparisonMode,
      splitPosition: grade.colorGradeSplitPosition,
    },
    persisted: {
      monitorVolume: playback.volume,
      monitorMuted: playback.muted,
      useProxy: playback.useProxy,
    },
    uiOnly: {
      playback: playback.isPlaying ? 'play' : 'pause',
      currentFrame: playback.currentFrame,
      comparisonMode: grade.colorGradeComparisonMode,
      splitPosition: grade.colorGradeSplitPosition,
    },
  }
}

const setPreviewStateSchema = z
  .object({
    playback: z.enum(['play', 'pause']).optional(),
    seekSeconds: z.number().nonnegative().optional(),
    monitorVolume: z.number().min(0).max(1).optional(),
    monitorMuted: z.boolean().optional(),
    useProxy: z.boolean().optional(),
    comparisonMode: z.enum(['off', 'before', 'split']).optional(),
    splitPosition: z.number().min(0.05).max(0.95).optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'At least one preview state value is required.',
  })

const setPreviewState = definePlatformTool({
  name: 'set_preview_state',
  title: 'Set preview state',
  description:
    'Play, pause, or seek the preview; set persisted monitor volume, mute, and proxy playback preferences; and set runtime color-grade before/split comparison state.',
  inputSchema: objectSchema({
    playback: { type: 'string', enum: ['play', 'pause'] },
    seekSeconds: { type: 'number', minimum: 0 },
    monitorVolume: { type: 'number', minimum: 0, maximum: 1 },
    monitorMuted: { type: 'boolean' },
    useProxy: { type: 'boolean' },
    comparisonMode: { type: 'string', enum: ['off', 'before', 'split'] },
    splitPosition: { type: 'number', minimum: 0.05, maximum: 0.95 },
  }),
  schema: setPreviewStateSchema,
  summarize: () => 'Set FreeCut preview state',
  execute: (updates) => {
    if (
      updates.seekSeconds !== undefined &&
      isMicRecordingActive(useMicRecordingStore.getState().status)
    ) {
      return {
        ok: false,
        message: 'Cannot seek while a voiceover take is recording or paused.',
        data: readPreviewState(),
        error: {
          code: 'VOICEOVER_SEEK_BLOCKED',
          message: 'Stop or cancel the active voiceover take before seeking.',
          retryable: true,
        },
        changed: false,
      }
    }

    const playback = usePlaybackStore.getState()
    const grade = useGizmoStore.getState()
    const fps = useTimelineSettingsStore.getState().fps
    const before = {
      isPlaying: playback.isPlaying,
      currentFrame: playback.currentFrame,
      volume: playback.volume,
      muted: playback.muted,
      useProxy: playback.useProxy,
      comparisonMode: grade.colorGradeComparisonMode,
      splitPosition: grade.colorGradeSplitPosition,
    }

    if (updates.seekSeconds !== undefined) {
      playback.setCurrentFrame(Math.round(updates.seekSeconds * fps))
    }
    if (updates.playback === 'play') {
      playback.play()
    } else if (updates.playback === 'pause') {
      playback.pause()
    }
    if (
      updates.monitorVolume !== undefined &&
      usePlaybackStore.getState().volume !== updates.monitorVolume
    ) {
      playback.setVolume(updates.monitorVolume)
    }
    if (
      updates.monitorMuted !== undefined &&
      usePlaybackStore.getState().muted !== updates.monitorMuted
    ) {
      playback.setMuted(updates.monitorMuted)
    }
    if (
      updates.useProxy !== undefined &&
      usePlaybackStore.getState().useProxy !== updates.useProxy
    ) {
      playback.toggleUseProxy()
    }
    if (
      updates.comparisonMode !== undefined &&
      grade.colorGradeComparisonMode !== updates.comparisonMode
    ) {
      grade.setColorGradeComparisonMode(updates.comparisonMode)
    }
    if (
      updates.splitPosition !== undefined &&
      grade.colorGradeSplitPosition !== updates.splitPosition
    ) {
      grade.setColorGradeSplitPosition(updates.splitPosition)
    }

    const afterPlayback = usePlaybackStore.getState()
    const afterGrade = useGizmoStore.getState()
    const changed =
      before.isPlaying !== afterPlayback.isPlaying ||
      before.currentFrame !== afterPlayback.currentFrame ||
      before.volume !== afterPlayback.volume ||
      before.muted !== afterPlayback.muted ||
      before.useProxy !== afterPlayback.useProxy ||
      before.comparisonMode !== afterGrade.colorGradeComparisonMode ||
      before.splitPosition !== afterGrade.colorGradeSplitPosition

    return {
      ok: true,
      message: changed ? 'Updated FreeCut preview state.' : 'FreeCut preview state was unchanged.',
      data: readPreviewState(),
      changed,
    }
  },
})

export const EDITOR_STATE_PLATFORM_TOOLS = [
  manageVoiceoverRecording,
  setEditingBehavior,
  setPreviewState,
] as const
