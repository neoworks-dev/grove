// The seam between Grove's main process and whatever hosts it. The services in
// src/main only ask for what they need from a host (a data directory, a dialog,
// the clipboard, a way to answer routes and push events) and never import
// Electron for it, so the same code runs under Electron and, without it, as the
// native app's sidecar. A host installs its implementation once, before any
// module that calls `platform()` is evaluated: `electronInstall.ts` for the
// Electron app, `sidecar.ts` for the native one.

import type { IpcMainInvokeEvent } from 'electron'

/** A handler for one route; the first argument is the caller, then the call's own arguments. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RouteHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any

/** A native confirmation, with the index of the button the user pressed as its answer. */
export interface MessageBoxOptions {
  type: 'info' | 'warning' | 'error'
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
}

/** The parts of a window that routes act on. */
export interface WindowHandle {
  minimize(): void
  close(): void
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  isFullScreen(): boolean
  setFullScreen(fullScreen: boolean): void
}

/** What a custom URL scheme's handler is given and answers. */
export type ProtocolHandler = (request: Request) => Response | Promise<Response>

export interface Platform {
  /** Which host this is, for the few places that behave differently in each. */
  readonly name: 'electron' | 'sidecar'
  /** The directory every setting, credential and cache file lives under. */
  userDataPath(): string
  /** Whether this is an installed build, whose resources sit beside it. */
  isPackaged(): boolean
  /** The root of the checkout the app runs from, where `resources/` is in development. */
  appPath(): string
  /** Answers one route until the returned function is called. */
  handleRoute(channel: string, handler: RouteHandler): () => void
  /** Pushes an event to every window the host shows. */
  broadcast(channel: string, payload: unknown): void
  showMessageBox(options: MessageBoxOptions): Promise<number>
  /** Asks for a directory; null when the user cancels or the host cannot ask. */
  pickDirectory(): Promise<string | null>
  openExternal(url: string): Promise<void>
  /** Opens a file or folder with the system's default app; resolves to an error message, or '' when it worked. */
  openPath(path: string): Promise<string>
  clipboard: { readText(): string; writeText(text: string): void }
  /** The OS keychain's encryption, which a host without a keychain reports as unavailable. */
  encryption: {
    isAvailable(): boolean
    encrypt(text: string): Buffer
    decrypt(encrypted: Buffer): string
  }
  /** The window a route call came from, or null when the host has none to act on. */
  windowOf(event: IpcMainInvokeEvent): WindowHandle | null
  /** Runs script in the first window, for the debug routes. */
  evaluateInRenderer(expression: string): Promise<unknown>
  /** Serves a custom URL scheme until the returned function is called. */
  handleProtocol(scheme: string, handler: ProtocolHandler): () => void
}

let installed: Platform | null = null

/** Makes `next` the host every `platform()` call answers from. */
export function installPlatform(next: Platform): void {
  installed = next
}

/** The installed host; throws when none was installed, which means an entry point forgot to. */
export function platform(): Platform {
  if (!installed) {
    throw new Error('no platform is installed: import electronInstall or sidecar before ipc')
  }
  return installed
}
