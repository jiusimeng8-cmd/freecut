import { useEffect, useState } from 'react'
import { Check, Eye, EyeOff, KeyRound, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  BUILT_IN_CLOUD_MCP_BASE_URL,
  useCloudMcpConfigStore,
} from '@/shared/state/cloud-mcp-config-store'
import { CLOUD_AGENT_PROFILE_OPTIONS } from '../agent/cloud-agent-config-store'
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
  const resetConnection = useAgentStore((state) => state.resetConnection)

  const [businessKeyDraft, setBusinessKeyDraft] = useState(bridgeBusinessKey)
  const [showApiKey, setShowApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    if (!open) return
    setBusinessKeyDraft(bridgeBusinessKey)
  }, [bridgeBusinessKey, open])

  const canSave = Boolean(businessKeyDraft.trim() || bridgeBusinessKeyConfigured)

  const save = async () => {
    setSaving(true)
    setSaveError('')
    try {
      if (businessKeyDraft.trim() || bridgeBusinessKeyConfigured) {
        await updateBridgeConfig({
          baseUrl: BUILT_IN_CLOUD_MCP_BASE_URL,
          businessKey: businessKeyDraft,
        })
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
export function ModeSegmentedControl({
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
  const activeOption = options[activeIndex]!
  const nextOption = options[(activeIndex + 1) % options.length]!

  return (
    <button
      type="button"
      aria-label={`工作模式，当前${activeOption.label}，点击切换`}
      onClick={() => onChange(nextOption.id)}
      className="relative flex h-[18px] w-full rounded-full border border-white/5 bg-[#232326] p-0.5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.75)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden
        className="absolute inset-y-0.5 rounded-full border border-white/20 bg-gradient-to-b from-[#a9a9a9] to-[#7d7d7d] shadow-[0_1px_2px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.4)] transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{
          width: `calc((100% - 0.25rem) / ${options.length})`,
          transform: `translateX(${activeIndex * 100}%)`,
        }}
      />
      {options.map((option) => {
        const selected = option.id === value
        return (
          <span
            key={option.id}
            aria-hidden
            className={`relative z-10 flex flex-1 items-center justify-center rounded-full px-1 text-[10px] font-medium leading-none transition-colors ${
              selected ? 'text-[#181818]' : 'text-[#8f8f93] hover:text-[#cfcfd2]'
            }`}
          >
            {option.label}
          </span>
        )
      })}
    </button>
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
