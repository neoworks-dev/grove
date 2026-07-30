/**
 * grove's review protocol, as a nib tool.
 *
 * grove reviews an agent's file changes before they are kept: the user reads a
 * diff in the editor, accepts or rejects it hunk by hunk, and the agent is told
 * what happened. The agent asks for that review by calling `request_review`.
 *
 * The whole mechanism is `policy: "ask"`. nib parks the agent loop on a promise
 * whenever an "ask" tool is called and emits `agent.tool_use` with
 * `permission: "ask"`; grove's review bridge answers that confirmation once the
 * user has decided, which is exactly the blocking call grove needs. So `execute`
 * never decides anything — by the time it runs, grove has already allowed the
 * call, and the verdict arrives separately as a message.
 *
 * grove copies this file into nib's data directory at startup, where extensions
 * are global and therefore trusted without a prompt. Nothing is imported at
 * runtime: `z` and `defineTool` arrive on the `nib` object, because an extension
 * lives outside any node_modules tree. The handful of members used here are
 * described locally rather than imported from nib's own types, which grove has
 * no way to resolve — this file is a resource, not part of grove's build.
 */

// The slice of nib's ExtensionAPI this extension touches.
interface NibExtensionApi {
  z: {
    object(shape: Record<string, unknown>): unknown
    string(): { describe(text: string): unknown }
  }
  defineTool(definition: unknown): unknown
  registerTool(tool: unknown): void
}

export default function (nib: NibExtensionApi): void {
  const { z, defineTool } = nib

  nib.registerTool(
    defineTool({
      name: 'request_review',
      summary: 'Ask the user to review the changes you have made so far.',
      description:
        'Submit the file changes you have made so far for review. The user reads them as a diff ' +
        'and may revert individual hunks or comment on them; you are told the outcome before you ' +
        'continue. Call this when you have finished a coherent piece of work, not after every ' +
        'edit, and summarize what you changed and why.',
      schema: z.object({
        summary: z
          .string()
          .describe('One or two sentences on what you changed and why, for the review header.')
      }),
      policy: 'ask',
      parallelSafe: false,
      display: { label: '{summary}', input: 'hidden', result: 'text' },

      async execute() {
        return { content: 'Submitted for review.' }
      }
    })
  )
}
