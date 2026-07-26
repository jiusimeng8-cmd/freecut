import { useEffect, useState } from 'react'
import { Check, Eye, EyeOff, KeyRound, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  BUILT_IN_CLOUD_MCP_BASE_URL,
  useCloudMcpConfigStore,
} from '@/shared/state/cloud-mcp-config-store'
import {
  CLOUD_AGENT_PROFILE_OPTIONS,
  useCloudAgentConfigStore,
} from '../agent/cloud-agent-config-store'
import { useAgentStore } from '../agent'
import { useCloudAiSettingsStore } from '@/shared/state/cloud-ai-settings-store'

export function CloudAgentSettingsPopover() {
  const open = useCloudAiSettingsStore((state) => state.open)
  const openSettings = useCloudAiSettingsStore((state) => state.openSettings)
  const closeSettings = useCloudAiSettingsStore((state) => state.closeSettings)

  const bridgeBusinessKey = useCloudMcpConfigStore((state) => state.businessKey)
  const bridgeBusinessKeyConfigured = useCloudMcpConfigStore((state) => state.businessKeyConfigured)
  const updateBridgeConfig = useCloudMcpConfigStore((state) => state.updateConfig)
  const clearBridgeConfig = useCloudMcpConfigStore((state) => state.clearConfig)
  const profileId = useCloudAgentConfigStore((state) => state.profileId)
  const updateProfileId = useCloudAgentConfigStore((state) => state.updateProfileId)
  const resetConnection = useAgentStore((state) => state.resetConnection)

  const [businessKeyDraft, setBusinessKeyDraft] = useState(bridgeBusinessKey)
  const [profileIdDraft, setProfileIdDraft] = useState(profileId)
  const [showApiKey, setShowApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    if (!open) return
    setBusinessKeyDraft(bridgeBusinessKey)
    setProfileIdDraft(profileId)
  }, [bridgeBusinessKey, open, profileId])

  const canSave = Boolean(
    (businessKeyDraft.trim() || bridgeBusinessKeyConfigured) && profileIdDraft.trim(),
  )

  const save = async () => {
    setSaving(true)
    setSaveError('')
    try {
      if (businessKeyDraft.trim() || bridgeBusinessKeyConfigured) {
        await updateBridgeConfig({
          baseUrl: BUILT_IN_CLOUD_MCP_BASE_URL,
          businessKey: businessKeyDraft,
        })
        updateProfileId(profileIdDraft)
        resetConnection()
      }
      closeSettings()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const clearBridgeBusinessKey = async () => {
    setSaving(true)
    setSaveError('')
    try {
      await clearBridgeConfig()
      setBusinessKeyDraft('')
      setShowApiKey(false)
      resetConnection()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) openSettings()
        else closeSettings()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0 text-muted-foreground"
          aria-label="配置剪好 MCP"
          onClick={() => openSettings()}
        >
          <Settings2 className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-96 space-y-3 p-3">
        <div className="flex items-start gap-2">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <p className="text-sm font-medium text-foreground">剪好 MCP</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              123剪好就出片！
            </p>
          </div>
        </div>

        <div className="rounded-md border border-border p-2.5">
          <ApiKeyField
            label="剪好 MCP Key"
            value={businessKeyDraft}
            show={showApiKey}
            placeholder={bridgeBusinessKeyConfigured ? '已安全保存，输入新 Key 可替换' : 'sk-...'}
            onChange={setBusinessKeyDraft}
            onToggle={() => setShowApiKey((current) => !current)}
          />
        </div>

        {saveError && <p className="text-[10px] text-destructive">{saveError}</p>}
        <Button
          size="sm"
          className="h-8 w-full gap-1.5"
          onClick={() => void save()}
          disabled={!canSave || saving}
        >
          <Check className="h-3.5 w-3.5" />
          保存配置
        </Button>

        <div className="space-y-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">工作模式</span>
          <ModeSegmentedControl value={profileIdDraft} onChange={setProfileIdDraft} />
        </div>
        {bridgeBusinessKeyConfigured && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-full gap-1.5 text-destructive hover:text-destructive"
            onClick={() => void clearBridgeBusinessKey()}
            disabled={saving}
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除已保存的 MCP Key
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * A sliding-thumb segmented control, in the v0 template's palette.
 *
 * The thumb is one absolutely-positioned element that translates between slots
 * rather than a highlight redrawn on the active button, which is what lets the
 * selection animate instead of jumping. Labels sit above it so the moving
 * surface never covers the text mid-transition.
 */
function ModeSegmentedControl({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const options = CLOUD_AGENT_PROFILE_OPTIONS
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  )

  return (
    <div
      role="radiogroup"
      aria-label="工作模式"
      className="relative flex rounded-full bg-[#212121] p-1"
    >
      <span
        aria-hidden
        className="absolute inset-y-1 rounded-full bg-gradient-to-b from-[#c7c7c7] to-[#acacac] shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{
          width: `calc((100% - 0.5rem) / ${options.length})`,
          transform: `translateX(${activeIndex * 100}%)`,
        }}
      />
      {options.map((option) => {
        const selected = option.id === value
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.id)}
            className={`relative z-10 flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-[#212121] ${
              selected ? 'text-[#191919]' : 'text-[#cfcfcf] hover:text-white'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function ApiKeyField({
  label = 'API KEY',
  value,
  show,
  error,
  placeholder = 'sk-...',
  onChange,
  onToggle,
}: {
  label?: string
  value: string
  show: boolean
  error?: string
  placeholder?: string
  onChange: (value: string) => void
  onToggle: () => void
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <div className="relative">
        <Input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="h-8 pr-9 text-xs"
        />
        <button
          type="button"
          onClick={onToggle}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label={show ? '隐藏 API Key' : '显示 API Key'}
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
      {error && <span className="block text-[10px] text-destructive">{error}</span>}
    </label>
  )
}
