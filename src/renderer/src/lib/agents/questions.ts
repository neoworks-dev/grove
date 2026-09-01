/**
 * A tool call that is really a question for the user.
 *
 * Some harnesses ask by calling a tool: the input carries the questions and the
 * options, and the answer travels back as an edited input the call then runs
 * with. Nothing here knows the tool's name — a call whose input has this shape
 * is a question, whoever asked it, so a harness that names its own tool
 * differently is rendered the same way.
 */

import { asRecord, stringOf } from './tools'

export interface QuestionOption {
  label: string
  description: string
  preview?: string
}

export interface AgentQuestion {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

/** The questions in a tool input, or null when the call is not a question. */
export function questionsOf(input: unknown): AgentQuestion[] | null {
  const fields = asRecord(input)
  if (fields === null || !Array.isArray(fields.questions)) {
    return null
  }

  const questions: AgentQuestion[] = []
  for (const entry of fields.questions) {
    const question = questionOf(entry)
    if (question) questions.push(question)
  }
  if (questions.length === 0) {
    return null
  }
  return questions
}

function questionOf(entry: unknown): AgentQuestion | null {
  const record = asRecord(entry)
  if (record === null || typeof record.question !== 'string') {
    return null
  }
  const options = optionsOf(record.options)
  if (options.length === 0) {
    return null
  }
  return {
    question: record.question,
    header: stringOf(record.header),
    options,
    multiSelect: record.multiSelect === true
  }
}

function optionsOf(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) {
    return []
  }
  const options: QuestionOption[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (record === null || typeof record.label !== 'string') {
      continue
    }
    options.push({
      label: record.label,
      description: stringOf(record.description),
      preview: typeof record.preview === 'string' ? record.preview : undefined
    })
  }
  return options
}

/**
 * The input to run the call with, once the user has answered.
 *
 * Answers are keyed by the question text and a multi-select answer is one
 * comma-separated string, which is the shape the asking tool reports back to
 * the model.
 */
export function answeredInput(input: unknown, answers: Map<string, string[]>): unknown {
  const fields = asRecord(input)
  const answered: Record<string, string> = {}
  for (const [question, chosen] of answers) {
    if (chosen.length > 0) answered[question] = chosen.join(', ')
  }
  return { ...(fields ?? {}), answers: answered }
}

/** What the user chose, as one line per question, for the transcript. */
export function answerSummary(answers: Map<string, string[]>): string {
  const lines: string[] = []
  for (const [question, chosen] of answers) {
    lines.push(`${question} → ${chosen.join(', ')}`)
  }
  return lines.join('\n')
}
