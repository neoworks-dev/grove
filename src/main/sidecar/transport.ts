// The sidecar's end of the wire to the Rust host: every route a plugin registers is a
// request the UI can make, and every event the services push is a frame the UI hears.
// Frames are the ndjson RpcMessages the API socket already speaks (sdk/src/frames.ts),
// one per line, with the request's `method` as the route's channel and its `params` as
// the call's argument list. Requests go in on stdin, everything else comes out on
// stdout, and logs stay on stderr so they can never end up inside a frame.

import type { IpcMainInvokeEvent } from 'electron'
import { FrameDecoder, FrameError, encodeFrame } from '../../../sdk/src/frames'
import type { RpcMessage } from '../../../sdk/src/protocol'
import { RpcEndpoint } from '../../shared/rpc'
import type { RouteHandler } from '../platform'
import type { RouteTransport } from '../platform/sidecar'

/** What the transport reads frames from; a Node readable stream satisfies it. */
export interface FrameInput {
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown
  on(event: 'end' | 'close', listener: () => void): unknown
}

/** What the transport writes frames to; a Node writable stream satisfies it. */
export interface FrameOutput {
  write(chunk: string): unknown
}

/** What a route handler is given as its caller: nothing, since the sidecar has no windows. */
const NO_CALLER = { sender: null } as unknown as IpcMainInvokeEvent

export class StdioTransport implements RouteTransport {
  private routes = new Map<string, RouteHandler>()
  private endpoint: RpcEndpoint
  private output: FrameOutput
  private log: (message: string) => void

  constructor(output: FrameOutput, log: (message: string) => void) {
    this.output = output
    this.log = log
    this.endpoint = new RpcEndpoint((message) => this.writeFrame(message), 'even')
    this.endpoint.handle('sidecar.info', async () => this.describe())
    this.endpoint.setFallbackHandler((method, params) => this.invokeRoute(method, params))
  }

  /** Serves the channel until the returned function is called. */
  handleRoute(channel: string, handler: RouteHandler): () => void {
    this.routes.set(channel, handler)
    return () => {
      if (this.routes.get(channel) === handler) {
        this.routes.delete(channel)
      }
    }
  }

  /** Pushes an event to the UI. */
  broadcast(channel: string, payload: unknown): void {
    this.endpoint.event(channel, payload)
  }

  /** Every channel being served right now, sorted. */
  channels(): string[] {
    return [...this.routes.keys()].sort()
  }

  /** Starts answering requests read from the input; `onEnd` runs when the other side closes it. */
  listen(input: FrameInput, onEnd: () => void): void {
    const decoder = new FrameDecoder()
    input.on('data', (chunk) => {
      let messages: RpcMessage[]
      try {
        messages = decoder.push(chunk)
      } catch (error) {
        this.reportBadFrame(error, onEnd)
        return
      }
      for (const message of messages) {
        this.endpoint.handleMessage(message)
      }
    })
    input.on('end', onEnd)
    input.on('close', onEnd)
  }

  /** What the UI can ask the sidecar about itself before it makes any other call. */
  private describe(): { pid: number; platform: string; channels: string[] } {
    return { pid: process.pid, platform: 'sidecar', channels: this.channels() }
  }

  /** Runs the route a request names, as `ipcMain.handle` would, with the call's arguments spread. */
  private async invokeRoute(channel: string, params: unknown): Promise<unknown> {
    const handler = this.routes.get(channel)
    if (!handler) {
      throw new Error(`No handler registered for '${channel}'`)
    }
    let args: unknown[] = []
    if (Array.isArray(params)) {
      args = params
    }
    return handler(NO_CALLER, ...args)
  }

  /** Writes one frame; a payload that cannot be serialised is logged and dropped, not thrown into a service. */
  private writeFrame(message: RpcMessage): void {
    try {
      this.output.write(encodeFrame(message))
    } catch (error) {
      this.log(`[sidecar] could not send a ${message.kind} frame: ${(error as Error).message}`)
    }
  }

  /** A frame that does not parse means the two ends disagree about the protocol, so the pipe is done. */
  private reportBadFrame(error: unknown, onEnd: () => void): void {
    if (error instanceof FrameError) {
      this.log(`[sidecar] ${error.message}, closing`)
      onEnd()
      return
    }
    throw error
  }
}
