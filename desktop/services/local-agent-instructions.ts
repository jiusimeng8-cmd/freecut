/**
 * The system prompt and grounding text the local Agent loop sends with every
 * turn.
 *
 * These live in Main rather than the Renderer because Main is what dispatches
 * the turn. An earlier Renderer-side copy was stranded when the local Host took
 * over dispatch, and the loop ran with no instructions and no timeline facts at
 * all — the model had to infer both the app it was driving and what was on the
 * timeline from tool names alone.
 */

const MAX_TIMELINE_CONTEXT_CHARS = 8_000
const MAX_TOOL_CATALOG_CHARS = 6_000
const MAX_SUMMARY_CHARS = 20_000

export const LOCAL_AGENT_SYSTEM_PROMPT = `You are the FreeCut (剪好) editing assistant, running inside the user's video editor on their own machine.

How you work:
- Complete the request by calling tools. Do not describe manual UI steps for something a tool can do.
- Only a few tools are callable at first, but the catalog below lists every tool that exists, by name. Find the name you need there and call tool_describe on it — the tool becomes callable on the next turn. Ask for every tool the request needs in one turn; tool_describe calls batch.
- Use tool_search only when no name in the catalog looks right. Its queries are English keywords, e.g. "place media timeline".
- Read-only tools run immediately. Write tools pause for the user's approval, then their result comes back to you as a tool receipt — so keep going afterwards until the whole request is done.
- Multi-step requests are normal. "Import this folder and put it on the timeline" is an import call followed by a placement call, not one call.
- Read the tool receipts. They carry the ids, counts, and error messages the next call needs; a failed receipt tells you what to change rather than what to repeat.
- Target clips by the refs shown in the timeline section below (c1, c2, …). Omit refs only when a tool explicitly acts on the current selection.

How you reply:
- Answer in Chinese (简体中文), briefly. State what you found or what you changed.
- Never claim a change landed unless a tool receipt says it did.
- If the available tools cannot do it, say which capability is missing.`

/**
 * Renders the whole tool catalog as one name-only line per category.
 *
 * Names only, no descriptions or schemas: a simulation over 15 typical requests
 * put the full 170-tool tree at ~930 tokens, against ~3200 for a 22-tool
 * always-on set that still could not cover every request. Knowing a name is
 * enough to call tool_describe for it, and it removes the failure mode where the
 * model has to guess English search keywords for a tool it cannot see.
 */
export function buildToolCatalogOutline(
  tools: Array<{ name: string; category: string }>,
): string {
  const byCategory = new Map<string, string[]>()
  for (const tool of tools) {
    const names = byCategory.get(tool.category)
    if (names) names.push(tool.name)
    else byCategory.set(tool.category, [tool.name])
  }
  return [...byCategory.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, names]) => `${category}: ${[...names].sort().join(', ')}`)
    .join('\n')
}

/**
 * Composes the summary field of an Agent Turn request.
 *
 * Everything is packed into this one field on purpose: it is the only free-text
 * channel in the turn contract, so using it avoids a wire-format change that
 * would have to be rolled out to the cloud endpoint in lockstep.
 */
export function buildLocalAgentSummary(input: {
  timelineContext?: string
  threadSummary?: string
  toolCatalog?: string
}): string {
  const sections = [LOCAL_AGENT_SYSTEM_PROMPT]
  const catalog = input.toolCatalog?.trim()
  if (catalog) {
    sections.push(
      'Tool catalog — every tool on this machine, grouped by category. ' +
        'Call tool_describe with an exact name to make one callable.\n' +
        catalog.slice(0, MAX_TOOL_CATALOG_CHARS),
    )
  }
  const timeline = input.timelineContext?.trim()
  sections.push(
    timeline
      ? `Current timeline (as of the user's request):\n${timeline.slice(0, MAX_TIMELINE_CONTEXT_CHARS)}`
      : // Said explicitly so the model reads for itself instead of assuming an
        // empty project and telling the user there is nothing to edit.
        'Current timeline: unavailable. Use a read tool to inspect the project before acting on it.',
  )
  const threadSummary = input.threadSummary?.trim()
  if (threadSummary) sections.push(`Earlier in this conversation:\n${threadSummary}`)
  return sections.join('\n\n').slice(0, MAX_SUMMARY_CHARS)
}
