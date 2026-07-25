import { memo } from 'react'
import { AgentChatPanel } from './agent-chat-panel'

/**
 * Container for the AI sidebar tab. Local generation models are intentionally
 * not mounted here; the editing assistant delegates planning to the configured
 * cloud model and executes structured commands against the local editor.
 */
export const AiTab = memo(function AiTab() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
        <AgentChatPanel />
      </div>
    </div>
  )
})
