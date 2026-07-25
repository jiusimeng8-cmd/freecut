import { z } from 'zod'
import {
  HOTKEYS,
  createHotkeyExportDocument,
  findHotkeyConflicts,
  parseHotkeyImportDocument,
  resolveHotkeys,
  type HotkeyKey,
} from '@/config/hotkeys'
import { useSettingsStore } from '@/features/editor/deps/settings-contract'
import { changeAppLanguage, i18n } from '@/i18n'
import { SUPPORTED_LANGUAGE_CODES } from '@/i18n/languages'
import { CAPTION_STYLE_PRESETS } from '@/shared/typography/caption-style-presets'
import { useUiSoundStore } from '@/shared/state/ui-sound-store'
import { getDevLocalMediaHandles } from '@/infrastructure/storage/dev-workspace-handle'
import { requireWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { definePlatformTool, objectSchema } from './shared'

const HOTKEY_KEYS = Object.keys(HOTKEYS) as HotkeyKey[]
const CAPTION_PRESET_IDS = CAPTION_STYLE_PRESETS.map((preset) => preset.id)

function readSettingsData() {
  const settings = useSettingsStore.getState()
  const uiSound = useUiSoundStore.getState()
  return {
    snapEnabled: settings.snapEnabled,
    timelineSectionDividerPosition: settings.timelineSectionDividerPosition,
    canvasSnapEnabled: settings.canvasSnapEnabled,
    showWaveforms: settings.showWaveforms,
    showFilmstrips: settings.showFilmstrips,
    enableFilmstripExtraction: settings.enableFilmstripExtraction,
    editorDensity: settings.editorDensity,
    maxUndoHistory: settings.maxUndoHistory,
    autoSaveInterval: settings.autoSaveInterval,
    defaultCaptionStylePresetId: settings.defaultCaptionStylePresetId,
    language: i18n.resolvedLanguage ?? i18n.language,
    hotkeyOverrides: settings.hotkeyOverrides,
    uiSounds: {
      enabled: uiSound.enabled,
      volume: uiSound.volume,
      voice: uiSound.voice,
    },
  }
}

const readSettings = definePlatformTool({
  name: 'read_settings',
  requiresProject: false,
  title: 'Read settings',
  description:
    'Read all persisted FreeCut application, language, timeline, caption, and hotkey settings.',
  inputSchema: objectSchema({}),
  readOnly: true,
  schema: z.object({}),
  summarize: () => 'Read FreeCut settings',
  execute: () => ({
    ok: true,
    message: 'Read FreeCut application settings.',
    data: {
      settings: readSettingsData(),
      options: {
        editorDensity: ['compact'],
        autoSaveInterval: [0, 5, 10, 15, 20, 25, 30],
        captionStylePresetIds: CAPTION_PRESET_IDS,
        languageCodes: SUPPORTED_LANGUAGE_CODES,
        uiSoundVoices: ['signature', 'velvet', 'crisp'],
        hotkeyDefaults: HOTKEYS,
      },
    },
  }),
})

const updateSettingsSchema = z
  .object({
    snapEnabled: z.boolean().optional(),
    timelineSectionDividerPosition: z.number().nonnegative().nullable().optional(),
    canvasSnapEnabled: z.boolean().optional(),
    showWaveforms: z.boolean().optional(),
    showFilmstrips: z.boolean().optional(),
    enableFilmstripExtraction: z.boolean().optional(),
    editorDensity: z.literal('compact').optional(),
    maxUndoHistory: z.number().int().min(10).max(200).optional(),
    autoSaveInterval: z.number().int().min(0).max(30).multipleOf(5).optional(),
    defaultCaptionStylePresetId: z
      .string()
      .refine((value) => CAPTION_PRESET_IDS.includes(value), 'Unknown caption style preset.')
      .optional(),
    language: z
      .string()
      .refine((value) => SUPPORTED_LANGUAGE_CODES.includes(value), 'Unsupported language.')
      .optional(),
    uiSoundsEnabled: z.boolean().optional(),
    uiSoundVolume: z.number().min(0).max(1).optional(),
    uiSoundVoice: z.enum(['signature', 'velvet', 'crisp']).optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'At least one setting is required.',
  })

const updateSettings = definePlatformTool({
  name: 'update_settings',
  requiresProject: false,
  title: 'Update settings',
  description: 'Update one or more persisted FreeCut application or language settings.',
  inputSchema: objectSchema({
    snapEnabled: { type: 'boolean' },
    timelineSectionDividerPosition: { type: ['number', 'null'] },
    canvasSnapEnabled: { type: 'boolean' },
    showWaveforms: { type: 'boolean' },
    showFilmstrips: { type: 'boolean' },
    enableFilmstripExtraction: { type: 'boolean' },
    editorDensity: { type: 'string', enum: ['compact'] },
    maxUndoHistory: { type: 'number', minimum: 10, maximum: 200 },
    autoSaveInterval: { type: 'number', enum: [0, 5, 10, 15, 20, 25, 30] },
    defaultCaptionStylePresetId: { type: 'string', enum: CAPTION_PRESET_IDS },
    language: { type: 'string', enum: SUPPORTED_LANGUAGE_CODES },
    uiSoundsEnabled: { type: 'boolean' },
    uiSoundVolume: { type: 'number', minimum: 0, maximum: 1 },
    uiSoundVoice: { type: 'string', enum: ['signature', 'velvet', 'crisp'] },
  }),
  schema: updateSettingsSchema,
  summarize: () => 'Update FreeCut settings',
  execute: async (updates) => {
    const settings = useSettingsStore.getState()
    const uiSound = useUiSoundStore.getState()
    let changed = false

    const setSetting = <K extends Parameters<typeof settings.setSetting>[0]>(
      key: K,
      value: Parameters<typeof settings.setSetting<K>>[1],
    ) => {
      if (settings[key] === value) return
      settings.setSetting(key, value)
      changed = true
    }

    if (
      updates.language !== undefined &&
      (i18n.resolvedLanguage ?? i18n.language) !== updates.language
    ) {
      await changeAppLanguage(updates.language)
      changed = true
    }
    if (updates.snapEnabled !== undefined) setSetting('snapEnabled', updates.snapEnabled)
    if (updates.timelineSectionDividerPosition !== undefined) {
      setSetting('timelineSectionDividerPosition', updates.timelineSectionDividerPosition)
    }
    if (updates.canvasSnapEnabled !== undefined) {
      setSetting('canvasSnapEnabled', updates.canvasSnapEnabled)
    }
    if (updates.showWaveforms !== undefined) setSetting('showWaveforms', updates.showWaveforms)
    if (updates.showFilmstrips !== undefined) setSetting('showFilmstrips', updates.showFilmstrips)
    if (updates.enableFilmstripExtraction !== undefined) {
      setSetting('enableFilmstripExtraction', updates.enableFilmstripExtraction)
    }
    if (updates.editorDensity !== undefined) setSetting('editorDensity', updates.editorDensity)
    if (updates.maxUndoHistory !== undefined) {
      setSetting('maxUndoHistory', updates.maxUndoHistory)
    }
    if (updates.autoSaveInterval !== undefined) {
      setSetting('autoSaveInterval', updates.autoSaveInterval)
    }
    if (updates.defaultCaptionStylePresetId !== undefined) {
      setSetting('defaultCaptionStylePresetId', updates.defaultCaptionStylePresetId)
    }
    if (updates.uiSoundsEnabled !== undefined && uiSound.enabled !== updates.uiSoundsEnabled) {
      uiSound.setEnabled(updates.uiSoundsEnabled)
      changed = true
    }
    if (updates.uiSoundVolume !== undefined && uiSound.volume !== updates.uiSoundVolume) {
      uiSound.setVolume(updates.uiSoundVolume)
      changed = true
    }
    if (updates.uiSoundVoice !== undefined && uiSound.voice !== updates.uiSoundVoice) {
      uiSound.setVoice(updates.uiSoundVoice)
      changed = true
    }

    return {
      ok: true,
      message: changed ? 'Updated FreeCut settings.' : 'FreeCut settings were already up to date.',
      data: { settings: readSettingsData() },
      changed,
    }
  },
})

const manageHotkey = definePlatformTool({
  name: 'manage_hotkey',
  requiresProject: false,
  title: 'Manage hotkey',
  description:
    'Set, unbind, or reset one FreeCut keyboard shortcut, rejecting or overwriting binding conflicts.',
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['set', 'unbind', 'reset'] },
      key: { type: 'string', enum: HOTKEY_KEYS },
      binding: { type: 'string' },
      conflictPolicy: { type: 'string', enum: ['reject', 'overwrite'] },
    },
    ['operation', 'key'],
  ),
  schema: z.object({
    operation: z.enum(['set', 'unbind', 'reset']),
    key: z.string().refine((value): value is HotkeyKey => value in HOTKEYS, 'Unknown hotkey key.'),
    binding: z.string().trim().min(1).optional(),
    conflictPolicy: z.enum(['reject', 'overwrite']).optional(),
  }),
  summarize: ({ operation, key }) => `${operation} hotkey ${key}`,
  execute: ({ operation, key, binding, conflictPolicy = 'reject' }) => {
    const settings = useSettingsStore.getState()
    let changed = false
    if (operation === 'set') {
      if (!binding) throw new Error('binding is required when operation is "set".')
      const resolved = resolveHotkeys(settings.hotkeyOverrides)
      const conflicts = findHotkeyConflicts(resolved, binding, key)
      if (conflicts.length > 0 && conflictPolicy === 'reject') {
        return {
          ok: false,
          message: `Hotkey ${key} conflicts with ${conflicts.length} existing command${conflicts.length === 1 ? '' : 's'}.`,
          data: { key, binding, conflictPolicy, conflicts },
          error: {
            code: 'HOTKEY_CONFLICT',
            message: 'The requested binding is already assigned to another command.',
            path: 'binding',
          },
          changed: false,
        }
      }
      for (const conflictKey of conflicts) {
        settings.unbindHotkeyBinding(conflictKey)
        changed = true
      }
      if (resolved[key] !== binding || settings.hotkeyOverrides[key] === null) {
        settings.setHotkeyBinding(key, binding)
        changed = true
      }
    } else if (operation === 'unbind') {
      if (settings.hotkeyOverrides[key] !== null) {
        settings.unbindHotkeyBinding(key)
        changed = true
      }
    } else {
      if (key in settings.hotkeyOverrides) {
        settings.resetHotkeyBinding(key)
        changed = true
      }
    }
    return {
      ok: true,
      message: changed ? `Updated hotkey ${key}.` : `Hotkey ${key} was already up to date.`,
      data: {
        key,
        defaultBinding: HOTKEYS[key],
        override: useSettingsStore.getState().hotkeyOverrides[key] ?? null,
      },
      changed,
    }
  },
})

function safeJsonFileName(value: string | undefined): string {
  const fallback = `freecut-hotkeys-${new Date().toISOString().slice(0, 10)}.json`
  const printable = [...(value?.trim() || fallback)]
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
  const sanitized = printable.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '')
  return sanitized.toLowerCase().endsWith('.json') ? sanitized : `${sanitized}.json`
}

async function writeHotkeyExport(fileName: string, contents: string): Promise<string> {
  const root = requireWorkspaceRoot()
  const exports = await root.getDirectoryHandle('exports', { create: true })
  const settings = await exports.getDirectoryHandle('settings', { create: true })
  const file = await settings.getFileHandle(fileName, { create: true })
  const writable = await file.createWritable()
  await writable.write(contents)
  await writable.close()
  return `exports/settings/${fileName}`
}

async function readHotkeyImport(path: string): Promise<string> {
  const handles = (await getDevLocalMediaHandles(path)).filter((handle) =>
    handle.name.toLowerCase().endsWith('.json'),
  )
  if (handles.length !== 1) {
    throw new Error(
      handles.length === 0
        ? `No JSON hotkey preset was found at ${path}.`
        : `The path contains multiple JSON files: ${path}`,
    )
  }
  return (await handles[0]!.getFile()).text()
}

const transferHotkeys = definePlatformTool({
  name: 'transfer_hotkeys',
  requiresProject: false,
  title: 'Import or export hotkeys',
  description:
    'Export the complete FreeCut hotkey preset to the tool result or workspace, or import a preset from JSON/path.',
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['export', 'import'] },
      destination: { type: 'string', enum: ['result', 'workspace'] },
      fileName: { type: 'string' },
      path: { type: 'string' },
      json: { type: 'string' },
    },
    ['operation'],
  ),
  schema: z
    .object({
      operation: z.enum(['export', 'import']),
      destination: z.enum(['result', 'workspace']).optional(),
      fileName: z.string().trim().min(1).max(240).optional(),
      path: z.string().trim().min(1).optional(),
      json: z.string().min(1).optional(),
    })
    .superRefine((value, context) => {
      if (value.operation === 'import' && Number(!!value.path) + Number(!!value.json) !== 1) {
        context.addIssue({
          code: 'custom',
          message: 'Import requires exactly one of path or json.',
          path: ['path'],
        })
      }
      if (value.operation === 'export' && (value.path || value.json)) {
        context.addIssue({
          code: 'custom',
          message: 'path/json are only valid for import.',
          path: ['operation'],
        })
      }
    }),
  summarize: ({ operation }) => `${operation} FreeCut hotkeys`,
  execute: async ({ operation, destination = 'result', fileName, path, json }) => {
    if (operation === 'export') {
      const document = createHotkeyExportDocument(useSettingsStore.getState().hotkeyOverrides)
      if (destination === 'result') {
        return {
          ok: true,
          message: 'Exported the complete hotkey preset in the tool result.',
          data: { document },
          changed: false,
        }
      }
      const outputName = safeJsonFileName(fileName)
      const relativePath = await writeHotkeyExport(
        outputName,
        `${JSON.stringify(document, null, 2)}\n`,
      )
      return {
        ok: true,
        message: `Exported the hotkey preset to ${relativePath}.`,
        data: { fileName: outputName, relativePath },
        changed: true,
      }
    }

    const source = json ?? (await readHotkeyImport(path!))
    const result = parseHotkeyImportDocument(JSON.parse(source))
    useSettingsStore.getState().replaceHotkeyOverrides(result.overrides)
    return {
      ok: true,
      message: `Imported ${result.importedCommandCount} hotkey command${result.importedCommandCount === 1 ? '' : 's'}.`,
      data: {
        importedCommandCount: result.importedCommandCount,
        ignoredCommandCount: result.ignoredCommandCount,
        remappedCommandCount: result.remappedCommandCount,
        sourceVersion: result.sourceVersion,
        hotkeyOverrides: useSettingsStore.getState().hotkeyOverrides,
      },
      changed: true,
    }
  },
})

const resetHotkeys = definePlatformTool({
  name: 'reset_hotkeys',
  requiresProject: false,
  title: 'Reset all hotkeys',
  description: 'Reset every FreeCut keyboard shortcut while preserving other application settings.',
  inputSchema: objectSchema({}),
  destructive: true,
  schema: z.object({}),
  summarize: () => 'Reset all FreeCut hotkeys',
  execute: () => {
    const before = Object.keys(useSettingsStore.getState().hotkeyOverrides).length
    useSettingsStore.getState().resetHotkeys()
    return {
      ok: true,
      message:
        before === 0
          ? 'All hotkeys were already at their defaults.'
          : `Reset ${before} hotkey override${before === 1 ? '' : 's'}.`,
      data: { resetOverrideCount: before },
      changed: before > 0,
    }
  },
})

const resetSettings = definePlatformTool({
  name: 'reset_settings',
  requiresProject: false,
  title: 'Reset settings',
  description: 'Reset all FreeCut application settings and hotkey overrides to their defaults.',
  inputSchema: objectSchema({}),
  destructive: true,
  schema: z.object({}),
  summarize: () => 'Reset FreeCut settings',
  execute: () => {
    useSettingsStore.getState().resetToDefaults()
    const uiSound = useUiSoundStore.getState()
    uiSound.setEnabled(false)
    uiSound.setVolume(0.6)
    uiSound.setVoice('signature')
    return {
      ok: true,
      message: 'Reset FreeCut settings to defaults.',
      data: { settings: readSettingsData() },
      changed: true,
    }
  },
})

export const SETTINGS_PLATFORM_TOOLS = [
  readSettings,
  updateSettings,
  manageHotkey,
  transferHotkeys,
  resetHotkeys,
  resetSettings,
] as const
