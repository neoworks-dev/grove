// Recognising a tool call that is really a question, and turning the user's
// pick back into the input the call runs with.

import { describe, expect, test } from 'bun:test'
import { answeredInput, questionsOf } from '../src/renderer/src/lib/agents/questions'

const ASK = {
  questions: [
    {
      question: 'Which theme?',
      header: 'Theme',
      multiSelect: false,
      options: [
        { label: 'Mocha', description: 'Dark' },
        { label: 'Latte', description: 'Light' }
      ]
    }
  ]
}

describe('agent questions', () => {
  test('reads the questions out of an asking call', () => {
    expect(questionsOf(ASK)).toEqual([
      {
        question: 'Which theme?',
        header: 'Theme',
        multiSelect: false,
        options: [
          { label: 'Mocha', description: 'Dark', preview: undefined },
          { label: 'Latte', description: 'Light', preview: undefined }
        ]
      }
    ])
  })

  test('an ordinary tool call is not a question', () => {
    expect(questionsOf({ command: 'ls' })).toBeNull()
    expect(questionsOf({ questions: [{ question: 'no options?' }] })).toBeNull()
    expect(questionsOf('nonsense')).toBeNull()
  })

  test('answers are keyed by question, multi-select joined', () => {
    const answers = new Map([['Which theme?', ['Mocha', 'Latte']]])

    expect(answeredInput(ASK, answers)).toEqual({
      ...ASK,
      answers: { 'Which theme?': 'Mocha, Latte' }
    })
  })
})
