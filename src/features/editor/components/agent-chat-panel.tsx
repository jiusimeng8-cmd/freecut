import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Check, KeyRound, Loader2, Send, Sparkles, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useProjectStore } from '@/features/editor/deps/projects'
import { cn } from '@/shared/ui/cn'
import { isCloudMcpConfigured, useCloudMcpConfigStore } from '@/shared/state/cloud-mcp-config-store'
import { useAgentStore } from '../agent'
import { useCloudAgentConfigStore } from '../agent/cloud-agent-config-store'
import { CloudAgentSettingsPopover, ModeSegmentedControl } from './cloud-agent-settings-popover'
import { useCloudAiSettingsStore } from '@/shared/state/cloud-ai-settings-store'

const SUGGESTIONS = [
  '删除时间线中的静音',
  '删除口头语',
  '在播放头位置添加标题',
  '在播放头位置分割片段',
]

function LocalRunCard() {
  const run = useAgentStore((state) => state.localRun)
  const phase = useAgentStore((state) => state.phase)
  const activity = useAgentStore((state) => state.activity)
  const approve = useAgentStore((state) => state.approve)
  const cancel = useAgentStore((state) => state.cancel)

  if (!run) return null

  if (phase === 'running') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/30 p-2.5">
        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        {/* A run can span a dozen rounds and take a minute. Without the live line
            below, one unchanging spinner reads the same whether the Agent is
            working or hung. */}
        <p className="text-xs text-foreground">
          {activity ?? '本地 Agent 正在读取项目并协调工具。'}
        </p>
      </div>
    )
  }

  if (phase === 'waiting-approval') {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
        <p className="text-xs text-foreground">已准备好需要修改时间线的操作，正在等待本地审批。</p>
        {run.approval && (
          <p className="mt-1 text-[11px] text-muted-foreground">{run.approval.name}</p>
        )}
        {run.approval?.localPath && (
          <p className="mt-1 break-all text-[11px] text-amber-600 dark:text-amber-500">
            确认后将允许访问：{run.approval.localPath}
          </p>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          <Button size="sm" className="h-7 flex-1 gap-1.5" onClick={() => void approve()}>
            <Check className="h-3.5 w-3.5" />
            确认并执行
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-muted-foreground"
            onClick={cancel}
          >
            <X className="h-3.5 w-3.5" />
            取消
          </Button>
        </div>
      </div>
    )
  }

  if (phase === 'approving') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 p-2.5 text-xs text-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        {activity ?? '正在提交本地审批并执行工具。'}
      </div>
    )
  }

  return null
}

export const AgentChatPanel = memo(function AgentChatPanel() {
  const messages = useAgentStore((state) => state.messages)
  const phase = useAgentStore((state) => state.phase)
  const modelStatus = useAgentStore((state) => state.modelStatus)
  const loadError = useAgentStore((state) => state.loadError)
  const submit = useAgentStore((state) => state.submit)
  const approve = useAgentStore((state) => state.approve)
  const cancel = useAgentStore((state) => state.cancel)
  const clearChat = useAgentStore((state) => state.clearChat)
  const loadProjectConversation = useAgentStore((state) => state.loadProjectConversation)
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null)
  const baseUrl = useCloudMcpConfigStore((state) => state.baseUrl)
  const businessKey = useCloudMcpConfigStore((state) => state.businessKey)
  // Desktop clears the plaintext key from renderer state once it is stored in
  // safeStorage, so this flag is what actually changes on a successful save.
  // It must be subscribed here or the panel keeps showing the setup prompt.
  const businessKeyConfigured = useCloudMcpConfigStore((state) => state.businessKeyConfigured)
  const profileId = useCloudAgentConfigStore((state) => state.profileId)
  const updateProfileId = useCloudAgentConfigStore((state) => state.updateProfileId)
  const autoApprove = useCloudAgentConfigStore((state) => state.autoApprove)
  const updateAutoApprove = useCloudAgentConfigStore((state) => state.updateAutoApprove)

  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const busy = phase !== 'idle'
  const configured = isCloudMcpConfigured({ baseUrl, businessKey }, businessKeyConfigured)

  useEffect(() => {
    if (projectId) void loadProjectConversation(projectId)
  }, [loadProjectConversation, projectId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, phase])

  useEffect(() => {
    if (autoApprove && phase === 'waiting-approval') {
      void approve()
    }
  }, [approve, autoApprove, phase])

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setInput('')
      void submit(trimmed)
    },
    [submit],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        if (!busy) send(input)
      }
    },
    [busy, input, send],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2.5">
        <KeyRound className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">剪好 Agent</p>
          <p className="truncate text-[10px] text-muted-foreground">
            {configured ? '本地 Agent Host 已连接' : 'MCP Key 未配置'}
          </p>
        </div>
        <CloudAgentSettingsPopover />
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && phase === 'idle' && (
          <div className="space-y-3">
            <div className="flex items-start gap-2.5 border-b border-border pb-3">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div>
                <p className="text-xs font-medium text-foreground">
                  {configured ? '用自然语言协作剪辑' : '连接剪好 MCP'}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {configured
                    ? 'Agent 在本地管理对话、工具和审批，仅把每轮推理发送到所选模型。'
                    : '配置 MCP Key 后即可使用剪好 Agent。'}
                </p>
              </div>
            </div>

            {!configured ? (
              <Button
                size="sm"
                className="h-8 w-full gap-1.5"
                onClick={() => useCloudAiSettingsStore.getState().openSettings()}
              >
                <KeyRound className="h-3.5 w-3.5" />
                配置剪好 MCP Key
              </Button>
            ) : (
              <div className="grid grid-cols-1 gap-1.5">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => send(suggestion)}
                    className="min-h-8 rounded-md border border-border bg-secondary/20 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-[88%] whitespace-pre-wrap rounded-md px-2.5 py-1.5 text-xs leading-relaxed',
                message.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border bg-secondary/30 text-foreground',
              )}
            >
              {message.content}
            </div>
          </div>
        ))}

        <LocalRunCard />

        {loadError && phase === 'idle' && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-[11px] text-destructive">
            {loadError}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-2.5">
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={configured ? '描述你想完成的剪辑工作' : '请先配置剪好 MCP Key'}
            disabled={!configured || busy}
            className="max-h-28 min-h-9 flex-1 resize-none rounded-md border border-border bg-secondary/30 px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-60"
          />
          {phase === 'running' ? (
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9 shrink-0"
              onClick={cancel}
              aria-label="停止请求"
            >
              <X className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="h-9 w-9 shrink-0"
              disabled={busy || !configured || !input.trim()}
              onClick={() => send(input)}
              aria-label="发送"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <div className="w-24">
            <ModeSegmentedControl value={profileId} onChange={updateProfileId} />
          </div>
          <button
            type="button"
            aria-pressed={autoApprove}
            onClick={() => updateAutoApprove(!autoApprove)}
            className={cn(
              'h-[18px] rounded-full border px-2 text-[10px] font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              autoApprove
                ? 'border-white/20 bg-gradient-to-b from-[#a9a9a9] to-[#7d7d7d] text-[#181818] shadow-[0_1px_2px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.4)]'
                : 'border-white/5 bg-[#232326] text-[#8f8f93] shadow-[inset_0_1px_2px_rgba(0,0,0,0.75)] hover:text-[#cfcfd2]',
            )}
          >
            自动审批
          </button>
        </div>
        {messages.length > 0 && (
          <div className="mt-1.5 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
              onClick={clearChat}
              disabled={busy}
            >
              <Trash2 className="h-3 w-3" />
              清空当前视图
            </Button>
          </div>
        )}
        {modelStatus === 'loading' && (
          <p className="mt-1.5 text-[10px] text-muted-foreground">正在检查本地 Agent Host</p>
        )}
      </div>
    </div>
  )
})
