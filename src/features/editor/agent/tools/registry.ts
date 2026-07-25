/**
 * Editor tool registry — the single source of truth consumed by the cloud
 * agent and, via `mcp.ts`, a future MCP server.
 */

import { EDITOR_TOOLS } from './definitions'
import { PLATFORM_TOOLS } from './platform-tools'
import type { EditorAgentTool } from './types'

const ALL_TOOLS: readonly EditorAgentTool[] = [...EDITOR_TOOLS, ...PLATFORM_TOOLS]
const TOOLS_BY_NAME = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]))

export function listEditorTools(): readonly EditorAgentTool[] {
  return ALL_TOOLS
}

export function getEditorTool(name: string): EditorAgentTool | undefined {
  return TOOLS_BY_NAME.get(name)
}
