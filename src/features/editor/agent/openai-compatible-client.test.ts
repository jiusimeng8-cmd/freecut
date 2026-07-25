import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloudAgentCompletion, listCloudAgentModels } from './openai-compatible-client'

const config = {
  baseUrl: 'https://gateway.example.com/v1/',
  apiKey: 'test-key',
  model: 'test-model',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createCloudAgentCompletion', () => {
  it('sends an OpenAI-compatible tool request and returns tool calls', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '准备分割片段。',
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'split', arguments: '{"atSeconds":2}' },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const result = await createCloudAgentCompletion({
      config,
      messages: [{ role: 'user', content: '在两秒处分割' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'split',
            description: 'Split clips',
            parameters: {
              type: 'object',
              properties: { atSeconds: { type: 'number' } },
              additionalProperties: false,
            },
          },
        },
      ],
    })

    expect(result.content).toBe('准备分割片段。')
    expect(result.toolCalls[0]?.function.name).toBe('split')
    expect(fetchMock).toHaveBeenCalledOnce()

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('https://gateway.example.com/v1/chat/completions')
    expect(init?.headers).toEqual({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'test-model',
      tool_choice: 'auto',
      temperature: 0,
    })
  })

  it('surfaces the gateway error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }),
    )

    await expect(
      createCloudAgentCompletion({
        config,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      }),
    ).rejects.toThrow('Invalid API key')
  })

  it('loads models from a bare gateway origin in provider order', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'gpt-5.6' }, { id: 'gpt-5.5' }, { id: 'gpt-5.6' }],
        }),
        { status: 200 },
      ),
    )

    const models = await listCloudAgentModels({
      baseUrl: 'https://gateway.example.com',
      apiKey: 'test-key',
    })

    expect(models).toEqual(['gpt-5.6', 'gpt-5.5'])
    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example.com/v1/models', {
      headers: { Authorization: 'Bearer test-key' },
      signal: undefined,
    })
  })
})
