// The UI's end of the sidecar: `call` a route, listen to `on` an event. Plain TypeScript
// with no Node APIs, so it runs in the UI's QuickJS as well as under Bun, and with no
// dependency on the plugin kernel; the kernel will wrap it as a service.
//
// It speaks the same RpcMessage frames as the sidecar (see src/main/sidecar/transport.ts),
// through a `SidecarBridge` that carries them: in the app that is the Rust host's
// `sidecar_send` command and its `sidecar:*` events (gpui.ts), in tests a fake child.

import type { RpcMessage } from '../../sdk/src/protocol'
import { RpcEndpoint } from '../../sdk/src/rpc'

/** How the sidecar ended, as the host reports it. */
export interface SidecarExit {
  code: number | null
  message: string
}

/** What the host says about the sidecar it runs. */
export interface SidecarStatus {
  state: 'running' | 'exited' | 'disabled'
  pid?: number
  code?: number | null
  message?: string
}

/** What the sidecar says about itself: its process and every route it serves. */
export interface SidecarInfo {
  pid: number
  platform: string
  channels: string[]
}

/** The channel the frames travel over. */
export interface SidecarBridge {
  /** Hands a request frame to the host, which writes it to the sidecar. Rejects when it cannot. */
  send(frame: RpcMessage): Promise<unknown>
  /** Calls `handler` with each frame that answers a request, until the returned function is called. */
  onReply(handler: (frame: RpcMessage) => void): () => void
  /** Calls `handler` with the payload of each event on `channel`, until the returned function is called. */
  onEvent(channel: string, handler: (payload: unknown) => void): () => void
  /** Calls `handler` when the sidecar ends. */
  onExit(handler: (exit: SidecarExit) => void): () => void
  /** Whether the sidecar is running, for a client that started after it could have ended. */
  status(): Promise<SidecarStatus>
}

export class SidecarClient {
  private bridge: SidecarBridge
  private endpoint: RpcEndpoint
  private stopListening: (() => void)[] = []

  constructor(bridge: SidecarBridge) {
    this.bridge = bridge
    // The sidecar's own requests would use even ids; the UI's are odd.
    this.endpoint = new RpcEndpoint((frame) => this.deliver(frame), 'odd')
    this.stopListening.push(bridge.onReply((frame) => this.endpoint.handleMessage(frame)))
    this.stopListening.push(bridge.onExit((exit) => this.failPending(exit)))
  }

  /** Invokes a route like `ipcRenderer.invoke` does: the channel, then its arguments. */
  async call<Result = unknown>(channel: string, ...args: unknown[]): Promise<Result> {
    const result: unknown = await this.endpoint.request(channel, args)
    return result as Result
  }

  /** Listens to an event the sidecar pushes; returns the function that stops listening. */
  on(channel: string, handler: (payload: unknown) => void): () => void {
    return this.bridge.onEvent(channel, handler)
  }

  /** Calls `handler` when the sidecar ends; returns the function that stops listening. */
  onExit(handler: (exit: SidecarExit) => void): () => void {
    return this.bridge.onExit(handler)
  }

  /** Asks the sidecar about itself, which also waits until it has finished starting. */
  info(): Promise<SidecarInfo> {
    return this.call<SidecarInfo>('sidecar.info')
  }

  /** What the host says about the sidecar's process. */
  status(): Promise<SidecarStatus> {
    return this.bridge.status()
  }

  /** Stops listening to the bridge and fails every call still waiting. */
  dispose(): void {
    for (const stop of this.stopListening.splice(0)) {
      stop()
    }
    this.endpoint.failAllPending('the sidecar client was disposed')
  }

  /** Sends a frame; when the host cannot, the request it carried fails instead of waiting forever. */
  private deliver(frame: RpcMessage): void {
    this.bridge.send(frame).catch((error: Error) => this.failRequest(frame, error))
  }

  /** Answers a request that never left with the error that stopped it. */
  private failRequest(frame: RpcMessage, error: Error): void {
    if (frame.kind !== 'request') {
      return
    }
    const reply: RpcMessage = {
      kind: 'response',
      id: frame.id,
      error: { message: error.message, code: 'internal' }
    }
    this.endpoint.handleMessage(reply)
  }

  /** Fails every call that was waiting on a sidecar that is gone. */
  private failPending(exit: SidecarExit): void {
    this.endpoint.failAllPending(exit.message)
  }
}
