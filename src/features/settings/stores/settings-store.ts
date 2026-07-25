import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { EditorDensityPresetName } from '@/config/editor-layout'
import { DEFAULT_EDITOR_DENSITY_PRESET, normalizeEditorDensityPreset } from '@/config/editor-layout'
import {
  HOTKEYS,
  normalizeHotkeyBinding,
  sanitizeHotkeyOverrides,
  type HotkeyKey,
  type HotkeyOverrideMap,
} from '@/config/hotkeys'
import { CAPTION_STYLE_PRESETS } from '@/shared/typography/caption-style-presets'

/**
 * App-wide settings stored in localStorage
 */
interface AppSettings {
  // Timeline defaults
  snapEnabled: boolean
  // Vertical position (px) of the A/V section divider. Null = centered default.
  // A viewport layout preference, persisted globally (not per project).
  timelineSectionDividerPosition: number | null
  // Canvas/gizmo snap (preview area) — independent from timeline frame snap
  canvasSnapEnabled: boolean
  showWaveforms: boolean
  showFilmstrips: boolean
  enableFilmstripExtraction: boolean

  // Interface
  editorDensity: EditorDensityPresetName

  // Performance
  maxUndoHistory: number
  autoSaveInterval: number // minutes (0 = disabled)

  // Caption style preset applied when an existing transcript is inserted as captions.
  defaultCaptionStylePresetId: string

  // Keyboard shortcuts
  hotkeyOverrides: HotkeyOverrideMap
}

const DEFAULT_CAPTION_STYLE_PRESET_ID = CAPTION_STYLE_PRESETS[0]?.id ?? 'netflix'

function normalizeCaptionStylePresetId(value: unknown): string {
  return typeof value === 'string' && CAPTION_STYLE_PRESETS.some((preset) => preset.id === value)
    ? value
    : DEFAULT_CAPTION_STYLE_PRESET_ID
}

interface SettingsActions {
  setSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  setHotkeyBinding: (key: HotkeyKey, binding: string) => void
  unbindHotkeyBinding: (key: HotkeyKey) => void
  replaceHotkeyOverrides: (overrides: HotkeyOverrideMap) => void
  resetHotkeyBinding: (key: HotkeyKey) => void
  resetHotkeys: () => void
  resetToDefaults: () => void
}

type SettingsStore = AppSettings & SettingsActions

function areHotkeyOverridesEqual(left: HotkeyOverrideMap, right: HotkeyOverrideMap): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)

  if (leftKeys.length !== rightKeys.length) {
    return false
  }

  return leftKeys.every((key) => left[key as HotkeyKey] === right[key as HotkeyKey])
}

const DEFAULT_SETTINGS: AppSettings = {
  // Timeline defaults
  snapEnabled: true,
  timelineSectionDividerPosition: null,
  canvasSnapEnabled: true,
  showWaveforms: true,
  showFilmstrips: true,
  enableFilmstripExtraction: true,

  // Interface
  editorDensity: DEFAULT_EDITOR_DENSITY_PRESET,

  // Performance
  maxUndoHistory: 50,
  autoSaveInterval: 5, // Auto-save every 5 min by default — guards against tab crashes / lost work

  // Caption styling default
  defaultCaptionStylePresetId: DEFAULT_CAPTION_STYLE_PRESET_ID,

  // Keyboard shortcuts
  hotkeyOverrides: {},
}

/**
 * Settings store with localStorage persistence.
 *
 * Usage:
 *   const theme = useSettingsStore(s => s.theme);
 *   const setSetting = useSettingsStore(s => s.setSetting);
 *   setSetting('theme', 'light');
 */
export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,

      setSetting: (key, value) =>
        set(() => {
          if (key === 'editorDensity') {
            return { editorDensity: normalizeEditorDensityPreset(value) }
          }
          if (key === 'defaultCaptionStylePresetId') {
            return { defaultCaptionStylePresetId: normalizeCaptionStylePresetId(value) }
          }
          return { [key]: value }
        }),

      setHotkeyBinding: (key, binding) =>
        set((state) => {
          const normalizedBinding = normalizeHotkeyBinding(binding)
          if (!normalizedBinding || normalizedBinding === HOTKEYS[key]) {
            if (!(key in state.hotkeyOverrides)) {
              return state
            }

            const remainingOverrides = { ...state.hotkeyOverrides }
            delete remainingOverrides[key]
            return { hotkeyOverrides: remainingOverrides }
          }

          if (state.hotkeyOverrides[key] === normalizedBinding) {
            return state
          }

          return {
            hotkeyOverrides: {
              ...state.hotkeyOverrides,
              [key]: normalizedBinding,
            },
          }
        }),

      unbindHotkeyBinding: (key) =>
        set((state) => {
          if (state.hotkeyOverrides[key] === '') {
            return state
          }

          return {
            hotkeyOverrides: {
              ...state.hotkeyOverrides,
              [key]: '',
            },
          }
        }),

      replaceHotkeyOverrides: (overrides) =>
        set((state) => {
          const normalizedOverrides = sanitizeHotkeyOverrides(overrides)

          if (areHotkeyOverridesEqual(state.hotkeyOverrides, normalizedOverrides)) {
            return state
          }

          return { hotkeyOverrides: normalizedOverrides }
        }),

      resetHotkeyBinding: (key) =>
        set((state) => {
          if (!(key in state.hotkeyOverrides)) {
            return state
          }

          const remainingOverrides = { ...state.hotkeyOverrides }
          delete remainingOverrides[key]
          return { hotkeyOverrides: remainingOverrides }
        }),

      resetHotkeys: () =>
        set((state) => {
          if (Object.keys(state.hotkeyOverrides).length === 0) {
            return state
          }

          return { hotkeyOverrides: {} }
        }),

      resetToDefaults: () => set(DEFAULT_SETTINGS),
    }),
    {
      name: 'freecut-settings',
      version: 3,
      // v1: auto-save now defaults on. Enable it for anyone persisted under the old
      // default (0 = disabled) so a crashed or closed tab can't lose a long edit.
      // After this one-time bump the user's choice is sticky again (toggle in
      // Settings → General).
      // v3: remove persisted browser-local AI settings.
      migrate: (persistedState, version) => {
        let state = (persistedState as Partial<AppSettings> | undefined) ?? {}
        if (version < 1 && (state.autoSaveInterval == null || state.autoSaveInterval <= 0)) {
          state = { ...state, autoSaveInterval: 5 }
        }
        if (version < 3) {
          const remaining = { ...state } as Record<string, unknown>
          delete remaining.defaultWhisperModel
          delete remaining.defaultWhisperQuantization
          delete remaining.defaultWhisperLanguage
          delete remaining.captioningIntervalUnit
          delete remaining.captioningIntervalValue
          delete remaining.captionSearchMode
          state = remaining
        }
        return state
      },
      merge: (persistedState, currentState) => {
        const typedState = (persistedState as Partial<AppSettings> | undefined) ?? {}

        return {
          ...currentState,
          ...typedState,
          hotkeyOverrides: sanitizeHotkeyOverrides(typedState.hotkeyOverrides),
          editorDensity: normalizeEditorDensityPreset(typedState.editorDensity),
          defaultCaptionStylePresetId: normalizeCaptionStylePresetId(
            typedState.defaultCaptionStylePresetId,
          ),
        }
      },
    },
  ),
)
