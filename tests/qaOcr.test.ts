import { describe, expect, test } from 'bun:test'
import { centerOf, findText, parseOcrWords } from '../scripts/qa/ocr.ts'

/** One TSV row of tesseract output, in the enlarged screenshot's pixels. */
function row(block: number, line: number, left: number, top: number, width: number, height: number, confidence: number, text: string): string {
  return [5, 1, block, 1, line, 1, left, top, width, height, confidence, text].join('\t')
}

const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext'

/** Two tabs of the bottom panel, a sentence in the editor, and a smudge read as text. */
const tsv = [
  header,
  row(1, 1, 620, 1340, 120, 22, 91, 'Terminal'),
  row(2, 1, 834, 1340, 140, 22, 93, 'Problems'),
  row(3, 1, 680, 240, 60, 22, 92, 'Agent'),
  row(3, 1, 760, 240, 80, 22, 90, 'notes'),
  row(4, 1, 680, 400, 60, 22, 88, 'agent'),
  row(4, 1, 760, 400, 80, 22, 89, 'notes.'),
  row(5, 1, 10, 10, 8, 8, 12, '&')
].join('\n')

describe('parseOcrWords', () => {
  test('takes the enlargement back out, so boxes are in window pixels', () => {
    const problems = parseOcrWords(tsv).find((word) => word.text === 'Problems')
    expect(problems).toMatchObject({ x: 417, y: 670, width: 70, height: 11 })
  })

  test('drops what tesseract was not sure of', () => {
    expect(parseOcrWords(tsv).some((word) => word.text === '&')).toBe(false)
  })
})

describe('findText', () => {
  const words = parseOcrWords(tsv)

  test('finds a phrase as a run of words on one line', () => {
    expect(findText(words, 'Agent notes')).toEqual([{ x: 340, y: 120, width: 80, height: 11 }])
  })

  test('falls back to ignoring case and punctuation only when nothing matches exactly', () => {
    expect(findText(words, 'agent notes')).toHaveLength(2)
    expect(findText(words, 'Problems')).toHaveLength(1)
  })

  test('does not join words from different lines into a phrase', () => {
    expect(findText(words, 'Terminal Problems')).toEqual([])
  })

  test('lists matches top to bottom', () => {
    const found = findText(words, 'NOTES')
    expect(found.map((box) => box.y)).toEqual([120, 200])
  })

  test('a click lands in the middle of the match', () => {
    expect(centerOf(findText(words, 'Problems')[0])).toEqual({ x: 452, y: 676 })
  })
})
