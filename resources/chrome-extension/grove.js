// The extension's link to Grove: a native-messaging port to the host Grove
// installs ("Connect Chrome" in its settings), which relays the provider
// protocol (neoworks-dev/grove#353) to Grove's socket. The host pairs and says
// how the link is; this side speaks the RPC itself.
//
// States: the host's (`grove-down`, `needs-pairing`, `pairing`, `connecting`,
// `connected`), plus `host-missing` while the browser can't start the host.

export const HOST_NAME = 'dev.neoworks.grove'

// How often to try starting the host again once it couldn't be.
const RECONNECT_MS = 5000
// How long one of our requests may wait for Grove.
const REQUEST_TIMEOUT_MS = 30000

export class GroveConnection {
  /**
   * `onStatus(status)` hears every change of state; `onRequest(method, params)`
   * answers Grove's requests (`browser.cdp`, `browser.open`).
   */
  constructor({ onStatus, onRequest }) {
    this.onStatus = onStatus
    this.onRequest = onRequest
    this.port = null
    this.status = { state: 'connecting', detail: '' }
    this.pending = new Map()
    // Clients own odd ids; the host's handshake took 1.
    this.nextId = 3
    this.reconnectTimer = null
  }

  /** Whether Grove is reachable and paired. */
  get connected() {
    return this.status.state === 'connected'
  }

  /** Starts the host, unless it is already running. */
  connect() {
    if (this.port) return
    this.reconnectTimer = null
    const port = chrome.runtime.connectNative(HOST_NAME)
    this.port = port
    port.onMessage.addListener((message) => this.receive(message))
    port.onDisconnect.addListener(() => this.disconnected(port))
    port.postMessage({ type: 'status' })
  }

  /** Asks the host to pair with Grove, which prompts the user there. */
  pair() {
    if (!this.port) return
    this.port.postMessage({ type: 'pair' })
  }

  /** Sends a request to Grove and resolves with its result. */
  request(method, params) {
    if (!this.port || !this.connected) return Promise.reject(new Error('Grove isn’t connected.'))
    const id = this.nextId
    this.nextId += 2
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, { message: `Grove did not answer ${method}` }), REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.post({ kind: 'request', id, method, params })
    })
  }

  /** Sends Grove an event; dropped while not connected. */
  event(channel, payload) {
    if (!this.connected) return
    this.post({ kind: 'event', channel, payload })
  }

  // ── Plumbing ────────────────────────────────────────────────────

  /** One message from the host: its state, or an RPC frame from Grove. */
  receive(message) {
    if (message.type === 'status') {
      this.setStatus(message.state, message.detail)
      return
    }
    if (message.type !== 'rpc') return
    const frame = message.message
    if (frame.kind === 'response') {
      this.settle(frame.id, frame.error, frame.result)
      return
    }
    if (frame.kind === 'request') void this.answer(frame)
  }

  /** Answers one of Grove's requests with the handler's result, or its error. */
  async answer(frame) {
    try {
      const result = await this.onRequest(frame.method, frame.params)
      this.post({ kind: 'response', id: frame.id, result: resultOrNull(result) })
    } catch (error) {
      this.post({ kind: 'response', id: frame.id, error: errorFrame(error) })
    }
  }

  /** Settles one of our requests. */
  settle(id, error, result) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (error) {
      pending.reject(Object.assign(new Error(error.message), { code: error.code }))
      return
    }
    pending.resolve(result)
  }

  /** The host went away: not installed, crashed, or the browser stopped it. Retries. */
  disconnected(port) {
    if (this.port !== port) return
    this.port = null
    let detail = ''
    if (chrome.runtime.lastError) detail = chrome.runtime.lastError.message
    for (const id of [...this.pending.keys()]) this.settle(id, { message: 'Grove’s host stopped' })
    this.setStatus('host-missing', detail)
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS)
  }

  /** Records a new state and tells the listener when it changed. */
  setStatus(state, detail) {
    let text = ''
    if (detail) text = detail
    if (this.status.state === state && this.status.detail === text) return
    this.status = { state, detail: text }
    this.onStatus(this.status)
  }

  /** Writes one RPC frame to the host. */
  post(frame) {
    if (!this.port) return
    this.port.postMessage({ type: 'rpc', message: frame })
  }
}

/** A handler's result as a frame carries it: undefined isn't JSON. */
function resultOrNull(result) {
  if (result === undefined) return null
  return result
}

/** An error as a response frame carries it; a CDP error keeps its numeric code. */
function errorFrame(error) {
  const frame = { message: String(error && error.message) }
  if (error && error.code !== undefined) frame.code = error.code
  return frame
}
