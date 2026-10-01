// Proposing merge-conflict resolutions for the user to review.
//
// An agent asked to resolve conflicts answers here instead of editing the file:
// grove holds each proposal beside its conflict until the user accepts, edits
// or rejects it, and writes nothing until every conflict is settled.

import type { GroveTool } from '../harness'
import type { ProposalInput } from '../../conflictResolution'
import { stringOrNothing } from './toolInput'

/** Where proposals go; the conflict proposals service, or a test's stand-in. */
export interface ConflictProposalSink {
  propose(worktreePath: string, input: ProposalInput): Promise<{ ok: boolean; message: string }>
}

/** `propose_conflict_resolution`, recording into `sink`. */
export function conflictTool(sink: ConflictProposalSink): GroveTool {
  return {
    name: 'propose_conflict_resolution',
    summary: 'Propose how to resolve one merge conflict, for the user to review.',
    description:
      'Propose the resolution of one merge conflict when the user asked you to resolve ' +
      'conflicts. The user accepts, edits or rejects it; grove writes the file once every ' +
      'conflict is settled, so do not edit conflicted files yourself. Conflicts are numbered ' +
      'per file from 1, in the order they appear.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file, relative to the worktree.' },
        conflict: { type: 'number', description: "The conflict's number in the file, from 1." },
        resolution: {
          type: 'string',
          description:
            'The lines that replace the whole conflict region, markers included. Leave out ' +
            'only when not confident.'
        },
        reason: { type: 'string', description: 'One sentence on why this combination.' },
        confident: {
          type: 'boolean',
          description: 'False when you cannot tell how the sides should combine; say why in reason.'
        }
      },
      required: ['path', 'conflict', 'reason', 'confident'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{path} #{conflict}', input: 'hidden', result: 'text' },

    async execute(input, context) {
      const path = stringOrNothing(input.path)
      const conflict = input.conflict
      if (!path || typeof conflict !== 'number' || !Number.isInteger(conflict) || conflict < 1) {
        return { content: 'Name the file and the conflict number (from 1).', isError: true }
      }
      const reason = stringOrNothing(input.reason)
      if (!reason) return { content: 'Say in one sentence why.', isError: true }
      let resolution: string | null = null
      if (typeof input.resolution === 'string') resolution = input.resolution
      const confident = input.confident === true
      if (confident && resolution === null) {
        return { content: 'A confident proposal needs its resolution.', isError: true }
      }

      const result = await sink.propose(context.workspaceRoot, {
        path,
        conflict,
        resolution,
        reason: reason.trim(),
        confident,
        sessionId: context.sessionId
      })
      if (!result.ok) return { content: result.message, isError: true }
      return { content: result.message }
    }
  }
}
