/**
 * MCP adapter for the editor tool registry.
 *
 * This is the future-facing seam. The Model Context Protocol describes tools as
 * `{ name, description, inputSchema }` (listing) and `tools/call` → content
 * blocks (invocation) — which is exactly the shape our registry already has. The
 * two functions here are everything an MCP *server* would delegate to; standing
 * one up later is just choosing a transport:
 *
 *   • in-browser: a `postMessage` / `WebSocket` / WebRTC transport so an external
 *     MCP client (or our own cloud agent) can drive this editor tab;
 *   • headless: the edit CLI wraps the same `callTool` over stdio.
 *
 * Keeping this mapping in-tree (and tested) guarantees the registry stays
 * MCP-compatible as tools are added, without yet shipping a server.
 */

import { getEditorTool, listEditorTools } from './registry'
import {
  getToolCapabilityMetadata,
  listToolCapabilityCategories,
  type ToolCapabilityCategory,
  type ToolCapabilityGroup,
} from './capability-manifest'
import type {
  JsonSchema,
  NormalizedToolResult,
  ToolImpactFlag,
  ToolOperationManifest,
  ToolPhaseReceipt,
  ToolProjectRevision,
  ToolResult,
} from './types'

export interface McpToolDescriptor {
  name: string
  description: string
  inputSchema: JsonSchema
  _meta: {
    'freecut/category': {
      id: ToolCapabilityCategory
      title: string
      group: ToolCapabilityGroup
    }
  }
  annotations: {
    title: string
    readOnlyHint: boolean
    destructiveHint: boolean
    requiresProject: boolean
    handoffRequired: boolean
  }
}

export interface McpToolCategoryDescriptor {
  id: ToolCapabilityCategory
  title: string
  group: ToolCapabilityGroup
  tools: string[]
}

export interface McpToolSearchOptions {
  category?: ToolCapabilityCategory
  limit?: number
}

export interface McpCallResult {
  content: { type: 'text'; text: string }[]
  isError: boolean
  /** Structured payload mirrored from the tool result (MCP `structuredContent`). */
  structuredContent?: unknown
}

export interface McpToolCallResult extends McpCallResult {
  structuredContent: NormalizedToolResult
}

export interface McpCallContext {
  requestId?: string
  projectRevision?: ToolProjectRevision
  operationManifest?: ToolOperationManifest
  phaseReceipts?: ToolPhaseReceipt[]
  impactFlags?: ToolImpactFlag[]
}

export function normalizeToolResult(
  result: ToolResult,
  context: McpCallContext = {},
): NormalizedToolResult {
  const requestId = context.requestId ?? result.requestId ?? crypto.randomUUID()
  const changed = result.changed ?? false
  return {
    ...result,
    requestId,
    operationId: result.operationId ?? requestId,
    changed,
    projectRevision: result.projectRevision ?? context.projectRevision ?? null,
    changeSummary: result.changeSummary ?? (changed ? result.message : null),
    finalStatus: result.finalStatus ?? (result.ok ? 'succeeded' : 'failed'),
    error:
      result.error ??
      (result.ok ? null : { code: 'TOOL_EXECUTION_FAILED', message: result.message }),
    warnings: [...(result.warnings ?? [])],
    operationManifest: result.operationManifest ?? context.operationManifest,
    phaseReceipts: result.phaseReceipts ?? context.phaseReceipts ?? [],
    impactFlags:
      result.impactFlags ??
      context.impactFlags ??
      result.operationManifest?.impactFlags ??
      context.operationManifest?.impactFlags ??
      [],
    ...(result.reconciliationStatus ? { reconciliationStatus: result.reconciliationStatus } : {}),
    ...(result.reconciliation ? { reconciliation: result.reconciliation } : {}),
    ...(result.beforeSnapshotId ? { beforeSnapshotId: result.beforeSnapshotId } : {}),
    ...(result.afterSnapshotId ? { afterSnapshotId: result.afterSnapshotId } : {}),
    ...(result.beforeFingerprint ? { beforeFingerprint: result.beforeFingerprint } : {}),
    ...(result.afterFingerprint ? { afterFingerprint: result.afterFingerprint } : {}),
    ...(result.postReadback ? { postReadback: result.postReadback } : {}),
  }
}

function toMcpCallResult(result: ToolResult, context: McpCallContext): McpToolCallResult {
  const structuredContent = normalizeToolResult(result, context)
  return {
    content: [{ type: 'text', text: structuredContent.message }],
    isError: !structuredContent.ok,
    structuredContent,
  }
}

const DEFAULT_MCP_TOOL_SEARCH_LIMIT = 8

function compareToolNames(left: McpToolDescriptor, right: McpToolDescriptor) {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}

function getToolSearchText(tool: McpToolDescriptor) {
  const category = tool._meta['freecut/category']
  return [
    tool.name,
    tool.annotations.title,
    tool.description,
    category.id,
    category.title,
    category.group,
  ]
    .join(' ')
    .toLowerCase()
}

function getSearchScore(tool: McpToolDescriptor, query: string) {
  if (!query) return 0

  const normalizedName = tool.name.toLowerCase()
  const normalizedTitle = tool.annotations.title.toLowerCase()
  const searchText = getToolSearchText(tool)
  const terms = query.split(/\s+/).filter(Boolean)
  let score = 0

  for (const term of terms) {
    if (normalizedName.includes(term)) score += 4
    else if (normalizedTitle.includes(term)) score += 3
    else if (searchText.includes(term)) score += 1
  }

  return score
}

/** MCP `tools/list`. */
export function listMcpTools(): McpToolDescriptor[] {
  return listEditorTools()
    .map((tool) => {
      const category = getToolCapabilityMetadata(tool.name)
      if (!category) throw new Error(`MCP tool ${tool.name} is missing capability classification.`)
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        _meta: {
          'freecut/category': category,
        },
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.destructive,
          requiresProject: tool.requiresProject,
          handoffRequired: tool.handoff,
        },
      }
    })
    .sort(compareToolNames)
}

export function listMcpToolCategories(): McpToolCategoryDescriptor[] {
  return listToolCapabilityCategories()
}

/**
 * Reads the local MCP catalog only. This never validates or executes a tool.
 * Callers should use it before loading a narrower set of descriptors into a
 * model turn.
 */
export function searchMcpTools(
  query: string,
  { category, limit = DEFAULT_MCP_TOOL_SEARCH_LIMIT }: McpToolSearchOptions = {},
): McpToolDescriptor[] {
  const normalizedQuery = query.trim().toLowerCase()
  const matched = listMcpTools()
    .filter((tool) => {
      if (category && tool._meta['freecut/category'].id !== category) return false
      return !normalizedQuery || getSearchScore(tool, normalizedQuery) > 0
    })
    .map((tool) => ({ tool, score: getSearchScore(tool, normalizedQuery) }))
    .sort((left, right) => right.score - left.score || compareToolNames(left.tool, right.tool))

  return matched.slice(0, Math.max(0, limit)).map(({ tool }) => tool)
}

/** Reads one local MCP descriptor without exposing the tool implementation. */
export function describeMcpTool(name: string): McpToolDescriptor | undefined {
  return listMcpTools().find((tool) => tool.name === name)
}

/** MCP `tools/call`. */
export async function callMcpTool(
  name: string,
  args: unknown,
  context: McpCallContext = {},
): Promise<McpToolCallResult> {
  const tool = getEditorTool(name)
  if (!tool) {
    const message = `Unknown tool: ${name}`
    return toMcpCallResult(
      {
        ok: false,
        message,
        changed: false,
        error: { code: 'TOOL_NOT_FOUND', message },
      },
      context,
    )
  }

  const validation = tool.validate(args)
  if (!validation.ok) {
    const message = `Invalid arguments — ${validation.error}`
    return toMcpCallResult(
      {
        ok: false,
        message,
        changed: false,
        error: { code: 'INVALID_ARGUMENTS', message },
      },
      context,
    )
  }

  try {
    const result = await tool.execute(validation.value)
    return toMcpCallResult(result, context)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool failed.'
    return toMcpCallResult(
      {
        ok: false,
        message,
        changed: false,
        error: { code: 'TOOL_EXECUTION_FAILED', message },
      },
      context,
    )
  }
}
