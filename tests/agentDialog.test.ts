import { describe, it, expect } from 'bun:test'
import { parseQuestions, buildAnswerResult } from '../src/renderer/src/lib/agentDialog'

describe('parseQuestions', () => {
  it('parses a questions array with options', () => {
    const questions = parseQuestions({
      questions: [
        {
          question: 'Which database?',
          header: 'Storage',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: 'relational' },
            { label: 'Redis', description: 'in-memory' }
          ]
        }
      ]
    })
    expect(questions).toHaveLength(1)
    expect(questions[0].question).toBe('Which database?')
    expect(questions[0].options.map((option) => option.label)).toEqual(['Postgres', 'Redis'])
    expect(questions[0].multiSelect).toBe(false)
  })

  it('tolerates string options and a single-question payload', () => {
    const questions = parseQuestions({ question: 'Pick one', options: ['a', 'b'] })
    expect(questions).toHaveLength(1)
    expect(questions[0].options.map((option) => option.label)).toEqual(['a', 'b'])
  })

  it('drops empty/malformed entries', () => {
    expect(parseQuestions({})).toEqual([])
    expect(parseQuestions({ questions: [{}] })).toEqual([])
  })
})

describe('buildAnswerResult', () => {
  it('pairs each question with its selected options', () => {
    const questions = parseQuestions({
      questions: [{ question: 'Q1', header: 'H1', options: [{ label: 'x' }, { label: 'y' }] }]
    })
    const result = buildAnswerResult(questions, [['y']])
    expect(result).toEqual({
      answers: [{ header: 'H1', question: 'Q1', selectedOptions: ['y'] }]
    })
  })
})
