// grove's tools over MCP, as the harnesses switchboard runs reach them.
//
// A real MCP client over the loopback HTTP server: the token decides which
// session's tools a harness sees, and a tool that asks is held on grove's
// approval flow before it runs.

import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ApprovalDecision, ApprovalRequest, GroveTool } from '../src/main/agents/harness'
import { GroveMcpServer, groveToolName, type ToolBinding } from '../src/main/agents/switchboard/mcpServer'

const servers: GroveMcpServer[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

function tool(name: string, policy: GroveTool['policy'], extra: Partial<GroveTool> = {}): GroveTool {
  return {
    name,
    summary: name,
    description: `the ${name} tool`,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    policy,
    execute: (input, context) => ({ content: `${name}:${String(input.text)}:${context.toolCallId}` }),
    ...extra
  }
}

/** A binding over the given tools, all of them listed unless told otherwise, recording what it was asked to approve. */
function binding(
  tools: GroveTool[],
  decide: (request: ApprovalRequest) => ApprovalDecision,
  listed: GroveTool[] = tools
): { bound: ToolBinding; asked: ApprovalRequest[] } {
  const asked: ApprovalRequest[] = []
  const bound: ToolBinding = {
    harnessSessionId: () => 'harness-1',
    tools: () => tools,
    listed: () => listed,
    context: { sessionId: 's1', workspaceRoot: '/w', surface: () => {}, show: () => {} },
    confirm: (request) => {
      asked.push(request)
      return Promise.resolve(decide(request))
    },
    callFor: (toolName) => ({ toolCallId: `call-${toolName}`, name: `mcp__grove__${toolName}` }),
    refusal: (candidate) => {
      if (candidate.name === 'refused') return 'not now'
      return null
    },
    report: () => {}
  }
  return { bound, asked }
}

/** An MCP client connected to a session's tools. */
async function connect(server: GroveMcpServer, bound: ToolBinding, token?: string): Promise<Client> {
  const { server: config } = await server.bind(bound)
  if (config.type !== 'http') throw new Error('expected an http server')
  const headers: Record<string, string> = {}
  for (const header of config.headers) headers[header.name] = header.value
  if (token !== undefined) headers.Authorization = `Bearer ${token}`
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } }))
  return client
}

/** The text of a tool call's result. */
function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content
  return content.map((block) => block.text).join('')
}

describe('grove tool names', () => {
  test('every harness spelling comes back to the bare name', () => {
    expect(groveToolName('mcp__grove__edit')).toBe('edit')
    expect(groveToolName('grove_edit')).toBe('edit')
    expect(groveToolName('grove.edit')).toBe('edit')
    expect(groveToolName('Edit')).toBeNull()
  })
})

describe('the MCP server', () => {
  test('lists the session its token names, leaving out denied tools', async () => {
    const server = new GroveMcpServer()
    servers.push(server)
    const { bound } = binding([tool('read', 'allow'), tool('edit', 'ask'), tool('hidden', 'deny')], () => ({
      result: 'allow'
    }))
    const client = await connect(server, bound)

    const listed = await client.listTools()
    expect(listed.tools.map((entry) => entry.name)).toEqual(['read', 'edit'])
    expect(listed.tools[0].annotations?.readOnlyHint).toBe(true)
    await client.close()
  })

  test('refuses a request without a token it knows', async () => {
    const server = new GroveMcpServer()
    servers.push(server)
    const { bound } = binding([tool('read', 'allow')], () => ({ result: 'allow' }))
    await expect(connect(server, bound, 'wrong')).rejects.toThrow()
  })

  test('runs an allowed tool straight away, on the call the harness reported', async () => {
    const server = new GroveMcpServer()
    servers.push(server)
    const { bound, asked } = binding([tool('read', 'allow')], () => ({ result: 'deny' }))
    const client = await connect(server, bound)

    const result = await client.callTool({ name: 'read', arguments: { text: 'a' } })
    expect(textOf(result)).toBe('read:a:call-read')
    expect(asked).toHaveLength(0)
    await client.close()
  })

  test('holds a tool that asks, with what it would do, and runs what the user edited', async () => {
    const server = new GroveMcpServer()
    servers.push(server)
    const edit = tool('edit', 'ask', {
      describe: () =>
        Promise.resolve({ kind: 'edit', content: [{ type: 'diff', path: '/w/a', oldText: 'x', newText: 'y' }] })
    })
    const { bound, asked } = binding([edit], () => ({ result: 'allow', input: { text: 'edited' } }))
    const client = await connect(server, bound)

    const result = await client.callTool({ name: 'edit', arguments: { text: 'original' } })
    expect(textOf(result)).toBe('edit:edited:call-edit')
    expect(asked).toHaveLength(1)
    expect(asked[0].toolCall).toMatchObject({
      toolCallId: 'call-edit',
      name: 'mcp__grove__edit',
      kind: 'edit',
      rawInput: { text: 'original' }
    })
    expect(asked[0].toolCall.content).toHaveLength(1)
    await client.close()
  })

  test('a declined call fails with the reason, without running', async () => {
    const server = new GroveMcpServer()
    servers.push(server)
    let ran = false
    const edit = tool('edit', 'ask', {
      execute: () => {
        ran = true
        return { content: '' }
      }
    })
    const { bound } = binding([edit], () => ({ result: 'deny', reason: 'wrong file' }))
    const client = await connect(server, bound)

    const result = await client.callTool({ name: 'edit', arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('wrong file')
    expect(ran).toBe(false)
    await client.close()
  })

  test('a tool the session may not use now is refused before anyone is asked', async () => {
    const server = new GroveMcpServer()
    servers.push(server)
    const { bound, asked } = binding([tool('refused', 'ask')], () => ({ result: 'allow' }))
    const client = await connect(server, bound)

    const result = await client.callTool({ name: 'refused', arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('not now')
    expect(asked).toHaveLength(0)
    await client.close()
  })

  test('lists only the tools given up front, and calls the rest through call_tool', async () => {
    const server = new GroveMcpServer()
    servers.push(server)
    const dispatcher = tool('call_tool', 'allow')
    const hidden = tool('show_diff', 'ask')
    const { bound, asked } = binding([tool('read', 'allow'), hidden, dispatcher], () => ({ result: 'allow' }), [
      tool('read', 'allow'),
      dispatcher
    ])
    const client = await connect(server, bound)

    const listed = await client.listTools()
    expect(listed.tools.map((entry) => entry.name)).toEqual(['read', 'call_tool'])

    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'show_diff', input: { text: 'a' } }
    })
    expect(textOf(result)).toBe('show_diff:a:call-show_diff')
    expect(asked).toHaveLength(1)
    expect(asked[0].toolCall).toMatchObject({ name: 'mcp__grove__show_diff', rawInput: { text: 'a' } })
    await client.close()
  })

  test('call_tool refuses a denied tool, an unknown one and itself', async () => {
    const server = new GroveMcpServer()
    servers.push(server)
    const { bound } = binding([tool('hidden', 'deny'), tool('call_tool', 'allow')], () => ({ result: 'allow' }))
    const client = await connect(server, bound)

    for (const name of ['hidden', 'missing', 'call_tool']) {
      const result = await client.callTool({ name: 'call_tool', arguments: { name, input: {} } })
      expect(result.isError).toBe(true)
    }
    await client.close()
  })
})
