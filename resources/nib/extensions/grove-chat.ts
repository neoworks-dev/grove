/**
 * The shared worktree chat channel, as nib tools.
 *
 * grove gives every worktree one channel that the user and every agent working
 * there can talk on. An extension cannot call back into grove, so the channel is
 * a file both sides append to — `.workbench/chat.jsonl` under the workspace
 * root, one JSON message per line. grove watches it; this writes to it.
 *
 * Reading is a tool rather than something injected into the prompt because the
 * agent should look when it has reason to, not carry the whole channel around.
 *
 * grove copies this file into nib's data directory at startup, where extensions
 * are global and therefore trusted without a prompt. Nothing is imported at
 * runtime: `z` and `defineTool` arrive on the `nib` object.
 */

// bun's own global, declared locally: this file is a resource rather than part
// of grove's build, so grove's TypeScript never sees bun's types.
declare const Bun: {
  file(path: string): { exists(): Promise<boolean>; text(): Promise<string> }
  write(path: string, contents: string): Promise<number>
}

// Must match CHANNEL_FILE in src/main/worktreeChannel.ts.
const CHANNEL_FILE = '.workbench/chat.jsonl'

// Agent↔agent chatter can loop; a ceiling per run keeps a runaway cheap.
const MAX_SENDS_PER_MINUTE = 30
const MINUTE_MS = 60_000

interface ChatMessage {
  id: string
  from: { kind: 'agent'; name: string }
  text: string
  ts: number
  to?: string
}

interface NibExtensionApi {
  z: {
    object(shape: Record<string, unknown>): unknown
    string(): { describe(text: string): unknown; optional(): unknown }
    number(): { describe(text: string): unknown; optional(): unknown }
  }
  defineTool(definition: unknown): unknown
  registerTool(tool: unknown): void
}

interface ToolContext {
  sessionId: string
  workspaceRoot: string
}

export default function (nib: NibExtensionApi): void {
  const { z, defineTool } = nib
  const sendTimes: number[] = []

  /** True while the run is under its own chatter ceiling. */
  function withinRateLimit(): boolean {
    const now = Date.now()
    while (sendTimes.length > 0 && now - sendTimes[0] > MINUTE_MS) sendTimes.shift()
    if (sendTimes.length >= MAX_SENDS_PER_MINUTE) return false
    sendTimes.push(now)
    return true
  }

  function channelPath(context: ToolContext): string {
    return `${context.workspaceRoot}/${CHANNEL_FILE}`
  }

  async function readChannel(context: ToolContext): Promise<ChatMessage[]> {
    const file = Bun.file(channelPath(context))
    if (!(await file.exists())) return []
    const messages: ChatMessage[] = []
    for (const line of (await file.text()).split('\n')) {
      if (line.trim().length === 0) continue
      try {
        messages.push(JSON.parse(line) as ChatMessage)
      } catch {
        // A half-written line from a concurrent append; skip it.
      }
    }
    return messages
  }

  nib.registerTool(
    defineTool({
      name: 'send_message',
      summary: 'Send a message to the other agents and the user in this worktree.',
      description:
        "Post a message on this worktree's shared channel, which the user and any other agents " +
        'working here can read. Use it to coordinate, not to report routine progress. Address one ' +
        'agent with "to".',
      schema: z.object({
        text: z.string().describe('The message to send.'),
        to: z.string().describe('Optional agent or session to address.').optional()
      }),
      policy: 'allow',
      parallelSafe: false,
      display: { label: '{text}', input: 'hidden', result: 'hidden' },

      async execute(input: { text: string; to?: string }, context: ToolContext) {
        if (!withinRateLimit()) {
          return { content: 'Rate limited: too many messages in the last minute.' }
        }

        const message: ChatMessage = {
          id: `${context.sessionId}-${Date.now()}-${sendTimes.length}`,
          from: { kind: 'agent', name: context.sessionId },
          text: input.text,
          ts: Date.now(),
          to: input.to
        }
        const path = channelPath(context)
        const existing = (await Bun.file(path).exists()) ? await Bun.file(path).text() : ''
        await Bun.write(path, `${existing}${JSON.stringify(message)}\n`)
        return { content: 'Message sent.' }
      }
    })
  )

  nib.registerTool(
    defineTool({
      name: 'read_messages',
      summary: "Read recent messages from this worktree's shared channel.",
      description:
        "Read what the user and any other agents have posted on this worktree's shared channel. " +
        'Pass "since" to read only what is new to you.',
      schema: z.object({
        since: z.number().describe('Only messages after this epoch-ms timestamp.').optional()
      }),
      policy: 'allow',
      parallelSafe: true,
      display: { label: 'channel', input: 'hidden', result: 'text' },

      async execute(input: { since?: number }, context: ToolContext) {
        const messages = await readChannel(context)
        const since = input.since
        const recent = since === undefined ? messages : messages.filter((entry) => entry.ts > since)
        if (recent.length === 0) return { content: 'No messages.' }
        return {
          content: recent.map((entry) => `[${entry.from.name}] ${entry.text}`).join('\n')
        }
      }
    })
  )
}
