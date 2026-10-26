// Finding things on screen by the text they show.
//
// Grove native draws everything itself, so there is no DOM or accessibility tree
// to ask where "Problems" is. What a person goes by is the text they read, and
// tesseract reads it too: the screenshot is enlarged first, because the app's
// smallest labels are about nine pixels tall, and each word comes back with its
// box. A phrase is found as a run of words on one line.

import { spawnSync } from 'node:child_process'

/** How much the screenshot is enlarged before it is read. */
export const OCR_SCALE = 2

/** Words tesseract is less sure of than this are left out. */
const MIN_CONFIDENCE = 40

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Word extends Box {
  text: string
  /** Block, paragraph and line numbers joined, so words on one line share it. */
  line: string
}

/**
 * The words in tesseract's TSV output, in window pixels: the enlargement is taken
 * back out, and words read with low confidence are dropped.
 */
export function parseOcrWords(tsv: string, scale: number = OCR_SCALE): Word[] {
  const words: Word[] = []
  for (const row of tsv.split('\n').slice(1)) {
    const fields = row.split('\t')
    if (fields.length < 12) {
      continue
    }
    const text = fields[11].trim()
    const confidence = Number(fields[10])
    if (text.length === 0 || confidence < MIN_CONFIDENCE) {
      continue
    }
    words.push({
      text,
      line: `${fields[2]}.${fields[3]}.${fields[4]}`,
      x: Math.round(Number(fields[6]) / scale),
      y: Math.round(Number(fields[7]) / scale),
      width: Math.round(Number(fields[8]) / scale),
      height: Math.round(Number(fields[9]) / scale)
    })
  }
  return words
}

/**
 * Every place a phrase appears, top to bottom and then left to right: runs of
 * consecutive words on one line whose text is the phrase. Exact matches are
 * preferred; without any, case and surrounding punctuation are ignored.
 */
export function findText(words: Word[], phrase: string): Box[] {
  const exact = matches(words, phrase, (word) => word)
  if (exact.length > 0) {
    return exact
  }
  return matches(words, phrase, loosely)
}

/** The runs of words that read as the phrase once both go through `normalize`. */
function matches(words: Word[], phrase: string, normalize: (value: string) => string): Box[] {
  const wanted = phrase.split(/\s+/).filter(Boolean).map(normalize)
  if (wanted.length === 0) {
    return []
  }
  const found: Box[] = []
  for (let start = 0; start + wanted.length <= words.length; start += 1) {
    const run = words.slice(start, start + wanted.length)
    if (!run.every((word) => word.line === run[0].line)) {
      continue
    }
    if (run.every((word, index) => normalize(word.text) === wanted[index])) {
      found.push(enclosing(run))
    }
  }
  return found.sort((first, second) => first.y - second.y || first.x - second.x)
}

/** A word without case or the punctuation around it, as a loose match compares it. */
function loosely(value: string): string {
  return value.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

/** The box around several boxes. */
export function enclosing(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** The middle of a box, where a click on it lands. */
export function centerOf(box: Box): { x: number; y: number } {
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

/** Reads the words of a screenshot with tesseract. */
export function readWords(screenshot: string): Word[] {
  const enlarged = spawnSync(
    'magick',
    [screenshot, '-resize', `${OCR_SCALE * 100}%`, '-colorspace', 'Gray', 'png:-'],
    { maxBuffer: 256 * 1024 * 1024 }
  )
  if (enlarged.status !== 0) {
    throw new Error(`could not prepare ${screenshot} for reading: ${String(enlarged.stderr).trim()}`)
  }
  const read = spawnSync('tesseract', ['stdin', 'stdout', '--psm', '11', 'tsv'], {
    input: enlarged.stdout,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  if (read.status !== 0) {
    throw new Error(`tesseract could not read ${screenshot}: ${read.stderr.trim()}`)
  }
  return parseOcrWords(read.stdout)
}
