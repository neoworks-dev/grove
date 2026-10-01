/**
 * A `browser` tool call → what it did in the page.
 *
 * The tool is the DevTools protocol unwrapped, so its input is a protocol method and its
 * parameters, or a script. Read as JSON, twenty of them are twenty identical rows; read as the
 * action each one was — navigate here, click there, type this — they are a story of what the
 * agent did to the page. The reply is text the model reads: the command's result, then what
 * the page logged since the last call, then where the page is now. This takes it apart again.
 */

import { asRecord, stringOf } from './tools'

/** The tool these helpers are about, as the transcript names it. */
export const BROWSER_TOOL = 'browser'

export type BrowserActionKind =
  | 'navigate'
  | 'reload'
  | 'pointer'
  | 'type'
  | 'key'
  | 'evaluate'
  | 'screenshot'
  | 'script'
  | 'other'

/** One call, as the action it was. */
export interface BrowserAction {
  kind: BrowserActionKind
  /** The verb a row leads with: "navigate", "click", "type", or the protocol method itself. */
  verb: string
  /** What the action was about, on one line: a URL, a point, the typed text, a key. */
  detail: string
  /** The code the call ran, for an evaluate or a script; '' otherwise. */
  code: string
  /** The protocol method, or '' for a script. */
  method: string
  params: Record<string, unknown>
}

/** One line of what the page logged between this call and the one before it. */
export interface BrowserLogLine {
  text: string
  /** A console error, or a request that failed. */
  isError: boolean
}

/** A call's reply, taken apart. */
export interface BrowserReply {
  /** What the command or script returned, as the model read it. */
  value: string
  /** Where the page was once the call finished, or '' when the reply does not say. */
  url: string
  title: string
  console: BrowserLogLine[]
  failedRequests: BrowserLogLine[]
  /** How many older log lines the reply left out to stay short. */
  leftOut: number
}

const CONSOLE_HEADING = 'Console since your last call:'
const NETWORK_HEADING = 'Failed requests since your last call:'
const LEFT_OUT = /^\[(\d+) earlier left out\]$/
const LOCATION = /^Now at (.*?)(?: \(“(.*)”\))?\.$/s
// What the tool says when a command returned nothing worth showing.
const NOTHING_RETURNED = 'Done.'

/** Whether a transcript call is the browser tool's. */
export function isBrowserCall(call: { name: string }): boolean {
  return call.name === BROWSER_TOOL
}

/** The action a call's input describes. */
export function browserActionOf(input: unknown): BrowserAction {
  const fields = asRecord(input)
  if (fields === null) {
    return action('other', BROWSER_TOOL, '', '', '', {})
  }
  const method = stringOf(fields.method)
  let params: Record<string, unknown> = {}
  const givenParams = asRecord(fields.params)
  if (givenParams !== null) {
    params = givenParams
  }
  if (method.length === 0 && typeof fields.script === 'string') {
    return action('script', 'script', firstLineOf(fields.script), fields.script, '', {})
  }
  return actionOfMethod(method, params)
}

/** A protocol command as the action it performs. */
function actionOfMethod(method: string, params: Record<string, unknown>): BrowserAction {
  if (method === 'Page.navigate') {
    return action('navigate', 'navigate', stringOf(params.url), '', method, params)
  }
  if (method === 'Page.reload') {
    return action('reload', 'reload', '', '', method, params)
  }
  if (method === 'Input.dispatchMouseEvent') {
    return pointerAction(params)
  }
  if (method === 'Input.insertText') {
    return action('type', 'type', stringOf(params.text), '', method, params)
  }
  if (method === 'Input.dispatchKeyEvent') {
    return keyAction(params)
  }
  if (method === 'Runtime.evaluate') {
    const expression = stringOf(params.expression)
    return action('evaluate', 'evaluate', firstLineOf(expression), expression, method, params)
  }
  if (method === 'Page.captureScreenshot') {
    return action('screenshot', 'screenshot', '', '', method, params)
  }
  return action('other', method || BROWSER_TOOL, '', '', method, params)
}

// What each mouse event does, said the way a person would.
const POINTER_VERBS: Record<string, string> = {
  mousePressed: 'click',
  mouseReleased: 'release',
  mouseMoved: 'move to',
  mouseWheel: 'scroll'
}

/** A mouse event: what it did, and where. */
function pointerAction(params: Record<string, unknown>): BrowserAction {
  const type = stringOf(params.type)
  let verb = POINTER_VERBS[type]
  if (verb === undefined) {
    verb = type || 'mouse'
  }
  let detail = `${stringOf(params.x)}, ${stringOf(params.y)}`
  if (type === 'mouseWheel') {
    detail = `${stringOf(params.deltaX) || '0'}, ${stringOf(params.deltaY) || '0'} at ${detail}`
  }
  if (params.button === 'right') {
    detail += ' (right button)'
  }
  return action('pointer', verb, detail, '', 'Input.dispatchMouseEvent', params)
}

/** A key event: the key, pressed or released. */
function keyAction(params: Record<string, unknown>): BrowserAction {
  const type = stringOf(params.type)
  let key = stringOf(params.key)
  if (key.length === 0) {
    key = stringOf(params.code) || stringOf(params.text)
  }
  let verb = 'key'
  if (type === 'keyUp') {
    verb = 'key up'
  }
  if (type === 'char') {
    verb = 'type'
  }
  return action('key', verb, key, '', 'Input.dispatchKeyEvent', params)
}

/** Builds an action; one place, so every kind carries every field. */
function action(
  kind: BrowserActionKind,
  verb: string,
  detail: string,
  code: string,
  method: string,
  params: Record<string, unknown>
): BrowserAction {
  return { kind, verb, detail, code, method, params }
}

/** The first non-blank line of some code, for a one-line header. */
function firstLineOf(code: string): string {
  for (const line of code.split('\n')) {
    if (line.trim().length > 0) {
      return line.trim()
    }
  }
  return ''
}

/**
 * A reply taken apart: the paragraph saying where the page is comes last, the page's log
 * before it, and everything ahead of those is what the command returned. A part a reply does
 * not have — a call that never reached the page has neither log nor location — is left empty.
 */
export function browserReplyOf(text: string): BrowserReply {
  const reply: BrowserReply = {
    value: '',
    url: '',
    title: '',
    console: [],
    failedRequests: [],
    leftOut: 0
  }
  const paragraphs = text.split('\n\n')
  const location = LOCATION.exec(lastOf(paragraphs))
  if (location !== null) {
    paragraphs.pop()
    reply.url = location[1]
    if (location[2] !== undefined) {
      reply.title = location[2]
    }
  }
  const log = lastOf(paragraphs)
  if (log.startsWith(CONSOLE_HEADING) || log.startsWith(NETWORK_HEADING)) {
    paragraphs.pop()
    readLog(log, reply)
  }
  reply.value = paragraphs.join('\n\n')
  return reply
}

function lastOf(paragraphs: string[]): string {
  if (paragraphs.length === 0) {
    return ''
  }
  return paragraphs[paragraphs.length - 1]
}

/** Sorts the log paragraph's lines under the heading each one came after. */
function readLog(log: string, reply: BrowserReply): void {
  let section: BrowserLogLine[] = reply.console
  for (const line of log.split('\n')) {
    if (line === CONSOLE_HEADING) {
      section = reply.console
      continue
    }
    if (line === NETWORK_HEADING) {
      section = reply.failedRequests
      continue
    }
    const leftOut = LEFT_OUT.exec(line)
    if (leftOut !== null) {
      reply.leftOut += Number(leftOut[1])
      continue
    }
    const entry = line.replace(/^- /, '')
    section.push({ text: entry, isError: section === reply.failedRequests || entry.startsWith('error:') })
  }
}

/** Whether any line of the page's log is an error, which is when the log opens by itself. */
export function logHasErrors(reply: BrowserReply): boolean {
  return reply.console.some((line) => line.isError) || reply.failedRequests.length > 0
}

/** What a call returned, for showing: a protocol result's value, or the reply as it came. */
export interface BrowserValue {
  text: string
  /** The page threw rather than returning. */
  isError: boolean
}

/**
 * The value a call returned, read for a person. `Runtime.evaluate` wraps it in a remote
 * object, so it is unwrapped to the value or its description, and an exception reads as the
 * error it was. A command that returned nothing returns ''.
 */
export function valueOf(action: BrowserAction, reply: BrowserReply): BrowserValue {
  if (reply.value === NOTHING_RETURNED) {
    return { text: '', isError: false }
  }
  if (action.kind !== 'evaluate') {
    return { text: reply.value, isError: false }
  }
  const parsed = asRecord(parseJson(reply.value))
  if (parsed === null) {
    return { text: reply.value, isError: false }
  }
  const exception = asRecord(parsed.exceptionDetails)
  if (exception !== null) {
    return { text: exceptionText(exception), isError: true }
  }
  return { text: remoteObjectText(asRecord(parsed.result)), isError: false }
}

/** What a thrown exception says about itself. */
function exceptionText(details: Record<string, unknown>): string {
  const thrown = asRecord(details.exception)
  if (thrown !== null && typeof thrown.description === 'string') {
    return thrown.description
  }
  return stringOf(details.text)
}

/** A remote object as it would print: its value when it came by value, else its description. */
function remoteObjectText(remote: Record<string, unknown> | null): string {
  if (remote === null) {
    return ''
  }
  if ('value' in remote) {
    return JSON.stringify(remote.value)
  }
  if (typeof remote.description === 'string') {
    return remote.description
  }
  return stringOf(remote.type)
}

/** Some JSON parsed, or undefined when it is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** JSON-looking text laid out over lines for reading; anything else as it came. */
export function prettyJson(text: string): string {
  const parsed = parseJson(text)
  if (parsed === undefined) {
    return text
  }
  return JSON.stringify(parsed, null, 2)
}
