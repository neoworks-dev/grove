// What the extension does to the DevTools protocol on its way between the tab
// and Grove: which events go up and how much of each, the screenshot scaled
// to one pixel per CSS pixel, Chrome's errors as CDP errors, and commands in
// words for the popup. No chrome.* here, so it runs under tests too.

/** The events Grove reads (neoworks-dev/grove#353), and the domains that emit them. */
export const FORWARDED_EVENTS = new Set([
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFailed',
  'Page.frameNavigated',
  'Page.navigatedWithinDocument'
])
export const EVENT_DOMAINS = ['Page', 'Runtime', 'Network']

// Longest URL sent up; a data: URL can be megabytes.
const URL_LENGTH = 2000
// Most console arguments sent up per message.
const CONSOLE_ARGUMENTS = 20

/** A CDP error as Grove reads it: `{ code, message }` on an Error. */
export function cdpError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Chrome's rejection of `chrome.debugger.sendCommand` as a CDP error. Chrome
 * puts the protocol's own error in the message as JSON; anything else is a
 * generic server error.
 */
export function parseCdpError(error) {
  const message = String(error && error.message)
  try {
    const parsed = JSON.parse(message)
    if (parsed && typeof parsed.message === 'string') return cdpError(parsed.code, parsed.message)
  } catch {
    // Not the protocol's error: Chrome's own, e.g. a detached tab.
  }
  return cdpError(-32000, message)
}

/** An event's params cut down to what Grove reads, so a big page can't flood the link. */
export function slimEvent(method, params) {
  const source = params || {}
  if (method === 'Network.requestWillBeSent') {
    const request = source.request || {}
    return { requestId: source.requestId, type: source.type, request: { method: request.method, url: shortUrl(request.url) } }
  }
  if (method === 'Network.responseReceived') {
    const response = source.response || {}
    return {
      requestId: source.requestId,
      type: source.type,
      response: { url: shortUrl(response.url), status: response.status, mimeType: response.mimeType }
    }
  }
  if (method === 'Network.loadingFailed') {
    return { requestId: source.requestId, type: source.type, errorText: source.errorText, canceled: source.canceled }
  }
  if (method === 'Runtime.consoleAPICalled') return slimConsoleCall(source)
  if (method === 'Runtime.exceptionThrown') return slimException(source)
  if (method === 'Page.frameNavigated') {
    const frame = source.frame || {}
    return { frame: { id: frame.id, parentId: frame.parentId, url: shortUrl(frame.url) } }
  }
  return source
}

/** A console call with its arguments capped and only the top stack frame. */
function slimConsoleCall(params) {
  let args = []
  if (Array.isArray(params.args)) args = params.args.slice(0, CONSOLE_ARGUMENTS).map(slimRemoteObject)
  const slim = { type: params.type, args }
  const frames = params.stackTrace && params.stackTrace.callFrames
  if (Array.isArray(frames) && frames.length > 0) {
    slim.stackTrace = { callFrames: [{ url: frames[0].url, lineNumber: frames[0].lineNumber }] }
  }
  return slim
}

/** An uncaught exception with only what names it. */
function slimException(params) {
  const details = params.exceptionDetails || {}
  const slim = { exceptionDetails: { text: details.text, url: details.url, lineNumber: details.lineNumber } }
  if (details.exception) slim.exceptionDetails.exception = { description: details.exception.description }
  return slim
}

/** A console argument with only the fields Grove prints. */
function slimRemoteObject(object) {
  const value = object || {}
  const slim = { type: value.type }
  if ('value' in value) slim.value = value.value
  if (value.description !== undefined) slim.description = value.description
  if (value.unserializableValue !== undefined) slim.unserializableValue = value.unserializableValue
  return slim
}

/** A URL cut to a length Grove has any use for. */
function shortUrl(url) {
  if (typeof url !== 'string') return url
  if (url.length <= URL_LENGTH) return url
  return `${url.slice(0, URL_LENGTH)}…`
}

/** The expression that reads what a CSS-pixel screenshot needs to know about the viewport. */
export const VIEWPORT_EXPRESSION =
  '({ devicePixelRatio, pageX: visualViewport.pageLeft, pageY: visualViewport.pageTop, width: innerWidth, height: innerHeight })'

/**
 * `Page.captureScreenshot` parameters that come back at one pixel per CSS
 * pixel. Chrome captures in device pixels, twice as wide as the page on a
 * HiDPI screen, so the capture is scaled by 1 / devicePixelRatio: a clip the
 * caller gave keeps its region, and without one the clip is the viewport.
 */
export function cssPixelScreenshotParams(params, viewport) {
  const ratio = Number(viewport && viewport.devicePixelRatio)
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio === 1) return params
  if (params.clip) {
    let scale = 1
    if (typeof params.clip.scale === 'number') scale = params.clip.scale
    return { ...params, clip: { ...params.clip, scale: scale / ratio } }
  }
  const clip = { x: viewport.pageX, y: viewport.pageY, width: viewport.width, height: viewport.height, scale: 1 / ratio }
  return { ...params, clip }
}

/** What a command does to the page, in words for the popup; null for one that only reads. */
export function describeCommand(method, params) {
  const values = params || {}
  if (method === 'Page.navigate') return `Opening ${values.url}`
  if (method === 'Page.reload') return 'Reloading'
  if (method === 'Page.captureScreenshot') return 'Taking a screenshot'
  if (method === 'Input.insertText') return `Typing “${shorten(String(values.text), 40)}”`
  if (method === 'Input.dispatchMouseEvent' && values.type === 'mousePressed') {
    return `Clicking at ${Math.round(Number(values.x))},${Math.round(Number(values.y))}`
  }
  if (method === 'Input.dispatchMouseEvent' && values.type === 'mouseWheel') return 'Scrolling'
  if (method === 'Input.dispatchKeyEvent' && (values.type === 'keyDown' || values.type === 'rawKeyDown')) {
    return `Pressing ${values.key || values.code}`
  }
  return null
}

/** Text cut to a length, with an ellipsis when it was cut. */
function shorten(text, length) {
  if (text.length <= length) return text
  return `${text.slice(0, length - 1)}…`
}

// Pages Chrome won't let an extension's debugger into.
const UNDRIVABLE_PREFIXES = [
  'chrome:',
  'chrome-extension:',
  'chrome-untrusted:',
  'devtools:',
  'edge:',
  'brave:',
  'view-source:',
  'https://chromewebstore.google.com/',
  'https://chrome.google.com/webstore'
]

/** Whether the extension can drive a tab at this URL. */
export function isDrivableUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return true
  return !UNDRIVABLE_PREFIXES.some((prefix) => url.startsWith(prefix))
}
