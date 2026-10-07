// grove's tools, served over MCP to the harnesses switchboard runs.
//
// The harnesses run as child processes and take their options as JSON, so the
// tools cannot be handed over as functions. One HTTP server on loopback serves
// every session instead: each session binds its tool set under a bearer token,
// and a harness reaches only the set it was given.
//
// Approval happens here rather than in the harness. Whether a harness asks
// before an MCP call differs from one to the next, and grove's policy is the
// same whichever of them made the call.

import { randomBytes, randomUUID } from 'crypto'
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'http'
import type { AddressInfo } from 'net'
import { McpServer as ProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js'
import type { McpServer, ToolCallUpdate } from '@neoworks/harness'
import type {
  ApprovalDecision,
  ApprovalRequest,
  GroveTool,
  GroveToolContext,
  GroveToolResult
} from '../harness'
import { CALL_TOOL, dispatchedCall } from '../tools/toolSearchTools'

/** The name grove's tools are published under; harnesses prefix it onto each tool. */
export const GROVE_SERVER = 'grove'

const MCP_PATH = '/mcp'

// How harnesses spell a tool grove serves: Claude and Codex prefix the server,
// pi's MCP adapter joins it with an underscore.
const GROVE_TOOL_PREFIXES = [
  `mcp__${GROVE_SERVER}__`,
  `${GROVE_SERVER}__`,
  `${GROVE_SERVER}.`,
  `${GROVE_SERVER}_`
]

/** A grove tool's bare name, or null when the name belongs to another tool. */
export function groveToolName(name: string): string | null {
  for (const prefix of GROVE_TOOL_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length)
  }
  return null
}

/** What one session puts behind its token. */
export interface ToolBinding {
  /** The harness's id for the session, which a permission request names. */
  harnessSessionId(): string
  /** Every tool the session can call. */
  tools(): GroveTool[]
  /** The tools whose schemas the harness is given; the rest are reached through `call_tool`. */
  listed(): GroveTool[]
  context: GroveToolContext
  /** Park a call on grove's approval flow. */
  confirm(request: ApprovalRequest): Promise<ApprovalDecision>
  /**
   * The call in flight the harness reported for this tool and input, so its
   * approval lands on the row the transcript already shows. Harnesses prefix
   * MCP tool names each in their own way, so the tool is named bare.
   */
  callFor(toolName: string, input: unknown): { toolCallId: string; name: string } | null
  /** Why the session may not call this tool right now, or null when it may. */
  refusal(tool: GroveTool): string | null
  /** Add to what the transcript shows of a call. */
  report(toolCallId: string, update: Omit<ToolCallUpdate, 'toolCallId'>): void
}

export interface BoundServer {
  /** The server as ACP hands it to a harness. */
  server: McpServer
  dispose(): void
}

export class GroveMcpServer {
  private http: HttpServer | null = null
  private listening: Promise<number> | null = null
  private bindings = new Map<string, ToolBinding>()

  /** Serve a session's tools, starting the server on first use. */
  async bind(binding: ToolBinding): Promise<BoundServer> {
    const port = await this.listen()
    const token = randomBytes(24).toString('hex')
    this.bindings.set(token, binding)
    return {
      server: {
        type: 'http',
        name: GROVE_SERVER,
        url: `http://127.0.0.1:${port}${MCP_PATH}`,
        headers: [{ name: 'Authorization', value: `Bearer ${token}` }]
      },
      dispose: () => {
        this.bindings.delete(token)
      }
    }
  }

  close(): void {
    this.http?.close()
    this.http = null
    this.listening = null
  }

  private listen(): Promise<number> {
    if (this.listening) return this.listening
    this.listening = new Promise((resolve, reject) => {
      const http = createServer((request, response) => void this.handle(request, response))
      http.once('error', reject)
      http.listen(0, '127.0.0.1', () => resolve(portOf(http)))
      this.http = http
    })
    return this.listening
  }

  /**
   * One MCP request. Stateless: every request gets a fresh protocol server over
   * the binding its token names, so nothing outlives the request but the binding.
   */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const binding = this.bindingOf(request)
    if (!binding) {
      response.writeHead(401).end()
      return
    }
    if (request.method !== 'POST' || !request.url?.startsWith(MCP_PATH)) {
      response.writeHead(405).end()
      return
    }

    const server = protocolServer(binding)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    response.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(request, response)
  }

  private bindingOf(request: IncomingMessage): ToolBinding | null {
    const header = request.headers.authorization
    if (!header?.startsWith('Bearer ')) return null
    const binding = this.bindings.get(header.slice('Bearer '.length))
    if (!binding) return null
    return binding
  }
}

/**
 * An MCP protocol server answering from one session's tools. The tools come
 * with JSON Schemas of their own, so the list and call handlers are set on the
 * low-level server rather than registered one by one through zod.
 */
function protocolServer(binding: ToolBinding): ProtocolServer {
  const protocol = new ProtocolServer(
    { name: GROVE_SERVER, version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  const server = protocol.server

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: binding
      .listed()
      .filter((tool) => tool.policy !== 'deny')
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as { type: 'object' },
        annotations: { readOnlyHint: tool.policy === 'allow' }
      }))
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let name = request.params.name
    let input: Record<string, unknown> = {}
    if (request.params.arguments) input = request.params.arguments
    // A call through `call_tool` is the call it names, approval and all.
    if (name === CALL_TOOL) {
      const called = dispatchedCall(input)
      if (!called) return errorResult(`${CALL_TOOL} needs the name of a tool to call.`)
      if (called.name === CALL_TOOL) return errorResult(`${CALL_TOOL} cannot call itself.`)
      name = called.name
      input = called.input
    }
    const tool = binding.tools().find((candidate) => candidate.name === name)
    if (!tool || tool.policy === 'deny') return errorResult(`No tool named ${name}.`)
    return callTool(binding, tool, input)
  })

  return protocol
}

/** Run a call, holding it for approval first when the tool asks. */
async function callTool(
  binding: ToolBinding,
  tool: GroveTool,
  input: Record<string, unknown>
): Promise<CallToolResult> {
  const refusal = binding.refusal(tool)
  if (refusal) return errorResult(refusal)

  // A harness that has not reported the call yet still gets it run; the row
  // it reports later is a second one, which beats running unasked.
  let call = binding.callFor(tool.name, input)
  if (!call) call = { toolCallId: randomUUID(), name: `mcp__${GROVE_SERVER}__${tool.name}` }
  const toolCallId = call.toolCallId
  const context: GroveToolContext = {
    ...binding.context,
    toolCallId,
    report: (update) => binding.report(toolCallId, update)
  }

  let runWith = input
  if (tool.policy === 'ask') {
    const described = await describeCall(tool, input, context)
    if ('failure' in described) return errorResult(described.failure)
    const decision = await approve(binding, tool, input, call, described.update)
    if (decision.result === 'deny') return errorResult(declined(decision))
    if (decision.input !== undefined) runWith = decision.input as Record<string, unknown>
  }

  try {
    const result = await tool.execute(runWith, context)
    return { content: resultContent(result), isError: result.isError === true }
  } catch (cause) {
    return errorResult((cause as Error).message)
  }
}

/** A tool's result as MCP content: its text, then any pictures. */
export function resultContent(result: GroveToolResult): CallToolResult['content'] {
  const content: CallToolResult['content'] = [{ type: 'text', text: result.content }]
  if (!result.images) return content
  for (const image of result.images) {
    content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  }
  return content
}

/** Put a call to grove's approval flow, as the permission request ACP would send. */
async function approve(
  binding: ToolBinding,
  tool: GroveTool,
  input: Record<string, unknown>,
  call: { toolCallId: string; name: string },
  described: Partial<ToolCallUpdate>
): Promise<ApprovalDecision> {
  return binding.confirm({
    sessionId: binding.harnessSessionId(),
    toolCall: {
      title: tool.summary,
      kind: 'other',
      ...described,
      toolCallId: call.toolCallId,
      name: call.name,
      rawInput: input
    },
    options: [
      { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }
    ]
  })
}

/**
 * What a tool says a call would do, or why it cannot. A call the tool cannot
 * describe (a path that does not resolve, anchors gone stale) would fail the
 * same way when it ran, so it goes back to the agent with the reason instead of
 * to the user as an approval with nothing to review.
 */
async function describeCall(
  tool: GroveTool,
  input: Record<string, unknown>,
  context: GroveToolContext
): Promise<{ update: Partial<ToolCallUpdate> } | { failure: string }> {
  if (!tool.describe) return { update: {} }
  try {
    const described = await tool.describe(input, context)
    return { update: described }
  } catch (cause) {
    return { failure: (cause as Error).message }
  }
}

/** The port a listening server was given. */
function portOf(http: HttpServer): number {
  const address: AddressInfo | string | null = http.address()
  if (address === null || typeof address === 'string')
    throw new Error('The tool server has no port.')
  return address.port
}

function declined(decision: ApprovalDecision): string {
  if (decision.reason) return `The user declined this call: ${decision.reason}`
  return 'The user declined this call.'
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}
