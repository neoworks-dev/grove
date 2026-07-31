/**
 * grove's AGENTS.md onboarding protocol, as a nib tool.
 *
 * The onboarding run walks a fixed set of phases, and grove's intro pane shows a
 * stepper following along. The agent reports where it has got to by calling
 * `set_phase`.
 *
 * An extension cannot call back into grove — it is in-process bun code with no
 * channel to the host — so the phase travels the way anything else reaches a
 * client: as an event on the session's stream. `setSurface` publishes a
 * declarative node under a known surface id, in the `panel` slot so it never
 * enters the conversation, and grove reads it back off the same stream it is
 * already watching.
 *
 * grove copies this file into nib's data directory at startup, where extensions
 * are global and therefore trusted without a prompt. Nothing is imported at
 * runtime: `z` and `defineTool` arrive on the `nib` object.
 */

// Kept in step with INTRO_PHASES in src/renderer/src/lib/intro/prompt.ts.
const PHASES = ['explore', 'interview', 'example', 'feedback', 'config', 'done']

// The surface id grove looks for. Changing it means changing intro.svelte.ts.
const SURFACE_ID = 'grove.intro'

interface NibSessionHandle {
  setSurface(surfaceId: string, slot: 'transcript' | 'panel', view: unknown): void
}

// The slice of nib's ExtensionAPI this extension touches.
interface NibExtensionApi {
  z: {
    object(shape: Record<string, unknown>): unknown
    enum(values: string[]): { describe(text: string): unknown }
  }
  defineTool(definition: unknown): unknown
  registerTool(tool: unknown): void
  session(sessionId: string): Promise<NibSessionHandle | null>
}

export default function (nib: NibExtensionApi): void {
  const { z, defineTool } = nib

  nib.registerTool(
    defineTool({
      name: 'set_phase',
      summary: 'Report which onboarding phase you are entering.',
      description:
        'Report the onboarding phase you are entering, so the introduction page can show ' +
        'progress. Call this as you begin each phase, not after finishing it.',
      schema: z.object({
        phase: z.enum(PHASES).describe('The onboarding phase you are entering.')
      }),
      policy: 'allow',
      parallelSafe: false,
      display: { label: '{phase}', input: 'hidden', result: 'hidden' },

      async execute(input: { phase: string }, context: { sessionId: string }) {
        const session = await nib.session(context.sessionId)
        session?.setSurface(SURFACE_ID, 'panel', {
          kind: 'text',
          text: input.phase,
          fallbackText: input.phase
        })
        return { content: `Phase set to ${input.phase}.` }
      }
    })
  )
}
