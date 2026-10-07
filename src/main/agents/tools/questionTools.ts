// Asking the user: grove mode's stand-in for the harness's own question tool,
// which goes with the rest of its tools.
//
// The call is held like any approval, and its input has the shape every
// question card already reads — `questions`, each with its options — so the
// renderer shows it as a question, not as a call to allow. The user's answers
// come back as the call's edited input, under `answers`, keyed by question.

import type { GroveTool } from '../harness'
import { textOf } from './toolInput'

export const ASK_USER = 'ask_user'

/** `ask_user`: one to four multiple-choice questions, answered in the chat pane. */
export function askUserTool(): GroveTool {
  return {
    name: ASK_USER,
    summary: 'Ask the user one to four multiple-choice questions and wait for the answers.',
    description:
      'Ask the user when a choice changes the outcome and you cannot settle it from the code ' +
      'or the conversation. Each question offers two to four options; the user picks one (or ' +
      'several with multiSelect) or types their own answer, so leave out an "Other" option. ' +
      'Put a recommended option first and say so in its label. Not for asking permission ' +
      'to act: tools that need it already ask.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The full question, ending in a question mark.'
              },
              header: {
                type: 'string',
                description: 'A tag of at most 12 characters, e.g. "Approach".'
              },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'The choice, in one to five words.' },
                    description: { type: 'string', description: 'What choosing it means.' }
                  },
                  required: ['label', 'description'],
                  additionalProperties: false
                }
              },
              multiSelect: {
                type: 'boolean',
                description: 'Whether several options can be picked.'
              }
            },
            required: ['question', 'header', 'options', 'multiSelect'],
            additionalProperties: false
          }
        }
      },
      required: ['questions'],
      additionalProperties: false
    },
    policy: 'ask',
    alwaysLoad: false,
    display: { title: 'Ask user', input: 'hidden', result: 'text' },

    // Checked before the user is asked: a question the card cannot show would
    // otherwise reach them as a bare call to allow.
    async describe(input) {
      const problem = problemWith(input.questions)
      if (problem) throw new Error(problem)
      return { title: 'Question', kind: 'other' }
    },

    execute(input) {
      return { content: answerReport(input) }
    }
  }
}

/** Why `questions` cannot be put to the user, or null when it can. */
function problemWith(questions: unknown): string | null {
  if (!Array.isArray(questions) || questions.length === 0) return 'Ask at least one question.'
  if (questions.length > 4) return 'Ask at most four questions at once.'
  for (const entry of questions) {
    const record = entry as { question?: unknown; options?: unknown } | null
    if (!record || !textOf(record.question)) return 'Every question needs its text.'
    if (!Array.isArray(record.options) || record.options.length < 2) {
      return `"${record.question}" needs at least two options.`
    }
    for (const option of record.options) {
      if (!textOf((option as { label?: unknown } | null)?.label)) {
        return `Every option of "${record.question}" needs a label.`
      }
    }
  }
  return null
}

/** The user's answers, one line per question, as the agent reads them. */
function answerReport(input: Record<string, unknown>): string {
  let answers: Record<string, unknown> = {}
  if (typeof input.answers === 'object' && input.answers !== null) {
    answers = input.answers as Record<string, unknown>
  }
  const lines: string[] = []
  for (const entry of input.questions as { question: string }[]) {
    const answer = textOf(answers[entry.question])
    if (answer === null) {
      lines.push(`"${entry.question}": no answer`)
    } else {
      lines.push(`"${entry.question}": ${answer}`)
    }
  }
  return `The user answered:\n${lines.join('\n')}`
}
