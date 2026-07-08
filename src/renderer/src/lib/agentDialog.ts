// Parse the (SDK-defined, loosely-typed) agent-question dialog payload into a
// render-friendly shape, and build the answer returned to the agent. Kept pure
// and defensive: the exact payload/result contract is opaque, so we read
// flexibly and return a clearly-structured, self-describing result (the model
// consumes it as the tool result, so descriptiveness matters more than an exact
// shape). Isolated here so it's easy to adjust once confirmed against a live run.

export interface DialogOption {
  label: string
  description?: string
  preview?: string
}

export interface DialogQuestion {
  question: string
  header?: string
  options: DialogOption[]
  multiSelect: boolean
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeOption(raw: unknown): DialogOption {
  if (typeof raw === 'string') return { label: raw }
  const option = (raw || {}) as Record<string, unknown>
  return {
    label: asString(option.label) || asString(option.value) || asString(option.text),
    description: asString(option.description) || undefined,
    preview: asString(option.preview) || undefined
  }
}

function normalizeQuestion(raw: unknown): DialogQuestion {
  const question = (raw || {}) as Record<string, unknown>
  const options = Array.isArray(question.options) ? question.options.map(normalizeOption) : []
  return {
    question: asString(question.question) || asString(question.prompt) || asString(question.title),
    header: asString(question.header) || undefined,
    options: options.filter((option) => option.label.length > 0),
    multiSelect: question.multiSelect === true
  }
}

// Extract the questions array from the dialog payload, tolerating a few shapes.
export function parseQuestions(payload: Record<string, unknown>): DialogQuestion[] {
  let list: unknown[] = []
  if (Array.isArray(payload.questions)) list = payload.questions
  else if (payload.question || payload.options) list = [payload]
  return list.map(normalizeQuestion).filter((q) => q.question || q.options.length > 0)
}

// Build the result handed back to the agent: one entry per question with the
// selected option labels.
export function buildAnswerResult(
  questions: DialogQuestion[],
  selections: string[][]
): { answers: { header: string; question: string; selectedOptions: string[] }[] } {
  return {
    answers: questions.map((question, index) => ({
      header: question.header || question.question,
      question: question.question,
      selectedOptions: selections[index] || []
    }))
  }
}
