// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { TaskRepository } from '../services/task-repository'
import { startBridgeHttpServer } from './bridge-http-server'
import { BridgeService } from './bridge-service'

const roots: string[] = []
const servers: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Bridge HTTP server', () => {
  it('serves the complete categorized registry over stateless MCP JSON-RPC', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-mcp-http-'))
    roots.push(root)
    const service = new BridgeService(new TaskRepository(join(root, 'tasks.json')))
    service.registerRenderer({
      clientId: 'renderer-1',
      projectId: 'project-1',
      tools: [
        {
          name: 'balance_color',
          description: 'Balance clip color.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          _meta: {
            'freecut/category': {
              id: 'color',
              title: 'Color grading',
              group: 'creative',
            },
          },
          annotations: {
            title: 'Balance color',
            readOnlyHint: false,
            destructiveHint: false,
            requiresProject: true,
            handoffRequired: false,
          },
        },
      ],
    })
    const server = await startBridgeHttpServer(service)
    servers.push(server)
    const call = (body: Record<string, unknown>) =>
      fetch(server.mcpUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${server.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
      })

    const initialized = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    })
    await expect(initialized.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
      },
    })

    const listed = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    await expect(listed.json()).resolves.toMatchObject({
      result: {
        tools: [
          {
            name: 'balance_color',
            _meta: {
              'freecut/category': {
                id: 'color',
                group: 'creative',
              },
            },
          },
        ],
      },
    })

    const categories = await call({
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/read',
      params: { uri: 'freecut://tool-categories' },
    })
    const categoryBody = (await categories.json()) as {
      result: { contents: Array<{ text: string }> }
    }
    expect(JSON.parse(categoryBody.result.contents[0]!.text)).toEqual({
      categories: [
        {
          id: 'color',
          title: 'Color grading',
          group: 'creative',
          tools: ['balance_color'],
        },
      ],
    })

    const failedCall = await call({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'missing_tool', arguments: {} },
    })
    await expect(failedCall.json()).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          ok: false,
          changed: false,
          error: { code: 'TOOL_NOT_FOUND' },
        },
      },
    })
  })

  it('requires callers to provide a stable requestId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-bridge-http-'))
    roots.push(root)
    const service = new BridgeService(new TaskRepository(join(root, 'tasks.json')))
    const server = await startBridgeHttpServer(service)
    servers.push(server)

    const response = await fetch(`${server.url}/v1/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${server.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'read_project', args: {} }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'BRIDGE_BAD_REQUEST',
        message: 'requestId is required.',
      },
    })
  })

  it('rejects malformed or non-JSON request bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-bridge-http-json-'))
    roots.push(root)
    const service = new BridgeService(new TaskRepository(join(root, 'tasks.json')))
    const server = await startBridgeHttpServer(service)
    servers.push(server)

    const malformed = await fetch(`${server.url}/v1/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${server.token}`,
        'Content-Type': 'application/json',
      },
      body: '{',
    })
    expect(malformed.status).toBe(400)

    const text = await fetch(`${server.url}/v1/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${server.token}`,
        'Content-Type': 'text/plain',
      },
      body: '{}',
    })
    expect(text.status).toBe(415)
  })
})
