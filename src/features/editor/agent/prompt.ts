import type { ChatMessage } from './agent-store'
import type { CloudAgentMessage } from './openai-compatible-client'

function buildSystemPrompt(): string {
  return `You are the FreeCut editing assistant embedded in a video editor.
Use the available tools to inspect and edit the current timeline.

Rules:
- Use tools instead of describing manual UI steps when a tool can complete the request.
- Read-only tools may be used to gather clip refs, transcript matches, and timecodes.
- Target clips by refs such as c1 or c2 from the timeline snapshot.
- Omit clip refs only when the tool explicitly supports the current selection.
- Use generate_captions for requests to transcribe speech or add synchronized subtitles to timeline media.
- Keep user-facing replies concise and state what you found or what you are about to change.
- If the request cannot be completed with the available tools, explain the missing capability.`
}

export function buildMessages(
  history: ChatMessage[],
  userText: string,
  contextText: string,
): CloudAgentMessage[] {
  return [
    { role: 'system', content: buildSystemPrompt() },
    ...history.slice(-8).map(
      (message): CloudAgentMessage => ({
        role: message.role,
        content: message.content,
      }),
    ),
    {
      role: 'user',
      content: `Current timeline:\n${contextText}\n\nUser request: ${userText}`,
    },
  ]
}
