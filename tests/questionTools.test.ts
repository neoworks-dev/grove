import { describe, expect, test } from 'bun:test'
import { askUserTool } from '../src/main/agents/tools/questionTools'
import type { GroveToolContext } from '../src/main/agents/harness'

const context: GroveToolContext = {
  sessionId: 's1',
  workspaceRoot: '/tmp',
  surface: () => {},
  show: () => {}
}

const question = {
  question: 'Which database?',
  header: 'Database',
  options: [
    { label: 'SQLite (recommended)', description: 'One file, no server.' },
    { label: 'Postgres', description: 'A server to run.' }
  ],
  multiSelect: false
}

describe('ask_user', () => {
  test('is held for the user, and listed up front', () => {
    const tool = askUserTool()
    expect(tool.policy).toBe('ask')
    expect(tool.alwaysLoad).toBe(true)
  })

  test('a question the card could not show goes back to the agent before the user sees it', async () => {
    const tool = askUserTool()
    const describe = tool.describe!
    await expect(describe({ questions: [] }, context)).rejects.toThrow('at least one question')
    const oneOption = { ...question, options: [question.options[0]] }
    await expect(describe({ questions: [oneOption] }, context)).rejects.toThrow('at least two options')
    await expect(describe({ questions: [question] }, context)).resolves.toMatchObject({ title: 'Question' })
  })

  test('the answers come back one line per question, with the unanswered ones said so', async () => {
    const tool = askUserTool()
    const second = { ...question, question: 'Which ORM?' }
    const result = await tool.execute(
      { questions: [question, second], answers: { 'Which database?': 'Postgres' } },
      context
    )
    expect(result.content).toBe(
      'The user answered:\n"Which database?": Postgres\n"Which ORM?": no answer'
    )
  })
})
