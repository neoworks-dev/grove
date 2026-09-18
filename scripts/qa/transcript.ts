// Watching the QA agent work.
//
// `claude --output-format stream-json` emits one JSON object per line, which is
// unreadable as it goes past. This renders it as a transcript instead: what the
// agent is thinking, what it did, and — in a terminal that can draw images —
// the screenshots it took, inline, at the point it looked at them.
//
// The screenshots are the reason this exists. A QA agent's work is mostly
// looking at the app, and a transcript without the pictures is a list of file
// paths nobody opens.

import { spawnSync } from 'node:child_process'
import type { Readable } from 'node:stream'

const style = {
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  reset: '\x1b[0m'
}

/** A screenshot the harness wrote, which is what gets drawn rather than named. */
const SHOT_PATH = /(\/\S*\.grove-qa\/shots\/\S+?\.png)/g

/**
 * Render a stream-json transcript to stdout until the stream ends.
 *
 * Deltas arrive token by token when the CLI was asked for partial messages, so
 * text is written as it comes rather than a paragraph at a time.
 */
export async function renderTranscript(stream: Readable): Promise<void> {
  const shown = new Set<string>()
  let buffer = ''
  let block: 'text' | 'thinking' | null = null

  /** Close whatever block is open, so the next thing starts on its own line. */
  const endBlock = (): void => {
    if (block === null) return
    process.stdout.write(`${style.reset}\n`)
    block = null
  }

  for await (const chunk of stream) {
    buffer += String(chunk)
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.trim().length === 0) continue
      let event: StreamEvent
      try {
        event = JSON.parse(line)
      } catch {
        // Anything the CLI prints that is not an event — a warning, a prompt —
        // is worth seeing as it is.
        console.log(line)
        continue
      }
      block = renderEvent(event, block, endBlock, shown)
    }
  }
  endBlock()
}

function renderEvent(
  event: StreamEvent,
  block: 'text' | 'thinking' | null,
  endBlock: () => void,
  shown: Set<string>
): 'text' | 'thinking' | null {
  if (event.type === 'stream_event') return renderDelta(event, block, endBlock)

  if (event.type === 'assistant') {
    let open = block
    for (const part of event.message?.content ?? []) {
      if (part.type !== 'tool_use') continue
      endBlock()
      open = null
      console.log(`${style.cyan}▸ ${describeToolUse(part)}${style.reset}`)
    }
    return open
  }

  if (event.type === 'user') {
    let open = block
    for (const part of event.message?.content ?? []) {
      if (part.type !== 'tool_result') continue
      endBlock()
      open = null
      renderToolResult(part, shown)
    }
    return open
  }

  if (event.type === 'result') {
    endBlock()
    let elapsed = 0
    if (event.duration_ms !== undefined) elapsed = Math.round(event.duration_ms / 1000)
    let spent = ''
    if (event.total_cost_usd !== undefined) spent = `, $${event.total_cost_usd.toFixed(2)}`
    console.log(`\n${style.bold}done${style.reset} ${style.dim}${elapsed}s${spent}${style.reset}`)
    return null
  }
  return block
}

/** Text and thinking, as they stream. */
function renderDelta(
  event: StreamEvent,
  block: 'text' | 'thinking' | null,
  endBlock: () => void
): 'text' | 'thinking' | null {
  const inner = event.event
  if (!inner) return block

  if (inner.type === 'content_block_stop') {
    endBlock()
    return null
  }
  if (inner.type !== 'content_block_delta' || !inner.delta) return block

  // A block can open with an empty delta, and a prefix with nothing after it
  // reads as the agent having thought something and said nothing.
  if (inner.delta.type === 'thinking_delta') {
    const thinking = inner.delta.thinking
    if (thinking === undefined || thinking.length === 0) return block
    if (block !== 'thinking') {
      endBlock()
      process.stdout.write(`${style.dim}· `)
    }
    process.stdout.write(thinking)
    return 'thinking'
  }
  if (inner.delta.type === 'text_delta') {
    const text = inner.delta.text
    if (text === undefined || text.length === 0) return block
    if (block !== 'text') {
      endBlock()
      process.stdout.write(style.reset)
    }
    process.stdout.write(text)
    return 'text'
  }
  return block
}

/** One line for what the agent did, with the noise taken out. */
function describeToolUse(part: ContentPart): string {
  const input = part.input ?? {}
  if (part.name === 'Bash' && typeof input.command === 'string') {
    return input.command.replace(/\s+/g, ' ').slice(0, 160)
  }
  if (typeof input.file_path === 'string') return `${part.name} ${input.file_path}`
  if (typeof input.pattern === 'string') return `${part.name} ${input.pattern}`
  return part.name ?? 'tool'
}

/**
 * What came back, and the screenshots it mentions.
 *
 * A tool result is mostly JSON the agent asked for and the reader does not need;
 * the exception is a path to a screenshot, which is the whole point of watching.
 */
function renderToolResult(part: ContentPart, shown: Set<string>): void {
  const text = resultText(part)
  const shots = [...text.matchAll(SHOT_PATH)].map((match) => match[1])

  const summary = text.replace(/\s+/g, ' ').trim().slice(0, 160)
  if (summary.length > 0 && shots.length === 0) {
    console.log(`${style.dim}  ${summary}${style.reset}`)
  }

  for (const shot of shots) {
    if (shown.has(shot)) continue
    shown.add(shot)
    console.log(`${style.dim}  ${shot}${style.reset}`)
    drawImage(shot)
  }
}

function resultText(part: ContentPart): string {
  if (typeof part.content === 'string') return part.content
  if (!Array.isArray(part.content)) return ''

  const texts: string[] = []
  for (const entry of part.content) {
    if (typeof entry.text === 'string') texts.push(entry.text)
  }
  return texts.join('\n')
}

// ------------------------------------------------------------------- images

let imageSupport: 'kitty' | 'none' | null = null

/** Draw a screenshot in the terminal, if this terminal can draw one. */
function drawImage(path: string): void {
  if (imageSupport === null) imageSupport = detectImageSupport()
  if (imageSupport === 'none') return

  // Inherited stdio: the kitten writes the graphics escape sequence to the
  // terminal itself, and needs the controlling tty to measure the window.
  spawnSync('kitten', ['icat', '--align', 'left', path], { stdio: 'inherit' })
}

/**
 * Whether the terminal will render an image, and why not when it will not.
 *
 * Inside tmux the graphics protocol only reaches the terminal if passthrough is
 * on, and it is off by default — which looks like a broken harness rather than
 * a setting, so say so once.
 */
function detectImageSupport(): 'kitty' | 'none' {
  const isKitty =
    process.env.KITTY_WINDOW_ID !== undefined ||
    process.env.TERM_PROGRAM === 'kitty' ||
    (process.env.TERM ?? '').includes('kitty')
  if (!isKitty) return 'none'

  if (!hasKitten()) {
    console.log(`${style.yellow}(screenshots not drawn: the kitten binary is not on PATH)${style.reset}`)
    return 'none'
  }
  if (process.env.TMUX !== undefined && !tmuxPassthroughOn()) {
    console.log(
      `${style.yellow}(screenshots not drawn inside tmux — turn the graphics protocol on:\n` +
        `  tmux set -g allow-passthrough on)${style.reset}`
    )
    return 'none'
  }
  return 'kitty'
}

function hasKitten(): boolean {
  return spawnSync('which', ['kitten'], { encoding: 'utf8' }).status === 0
}

function tmuxPassthroughOn(): boolean {
  const setting = spawnSync('tmux', ['show', '-gv', 'allow-passthrough'], { encoding: 'utf8' })
  if (setting.status !== 0) return false
  const value = setting.stdout.trim()
  return value === 'on' || value === 'all'
}

// The parts of the stream-json events this renders. The CLI emits a good deal
// more; what is not declared here is what is not drawn.
interface ContentPart {
  type: string
  name?: string
  input?: Record<string, unknown>
  content?: string | Array<{ type: string; text?: string }>
}

interface StreamEvent {
  type: string
  message?: { content?: ContentPart[] }
  event?: {
    type: string
    delta?: { type: string; text?: string; thinking?: string }
  }
  total_cost_usd?: number
  duration_ms?: number
}
