// Node client for the Grove local API socket. connectGrove() dials the
// socket, performs the api.hello handshake (pairing on first contact — the
// user approves inside Grove), persists the minted token, and returns a
// typed facade over the same routes in-app plugins use. Node-only imports
// stay behind the '@grove/plugin-sdk/client' entry so worker bundles never
// pull them in.

import { connect, type Socket } from 'net'
import type {
  AgentsApi,
  CancellationToken,
  EditorApi,
  GitApi,
  LanguagesApi,
  SearchMatch,
  ServicesApi,
  TerminalsApi
} from '../api'
import type { HelloParams, HelloResult, PluginPermission, RpcMessage } from '../protocol'
import { FrameDecoder, encodeFrame } from '../frames'
import { RpcEndpoint } from '../rpc'
import { discoverSocket } from './discovery'
import { loadToken, saveToken } from './tokenStore'

export interface ConnectOptions {
  // Same grammar as plugin ids, e.g. 'my-tool'.
  appId: string
  name: string
  version: string
  scopes: PluginPermission[]
  socketPath?: string
  token?: string
  // Called when pairing mints a fresh token. Default: the built-in token
  // store (~/.config/grove/tokens/<appId>, mode 600).
  onPairingToken?: (token: string) => void | Promise<void>
}

export interface GroveClientWorkspace {
  findFiles(options?: { worktreeId?: string }): Promise<string[]>
  readFile(path: string, options?: { worktreeId?: string }): Promise<string>
  readExcerpt(
    path: string,
    startLine: number,
    endLine: number,
    options?: { worktreeId?: string }
  ): Promise<{ n: number; text: string }[]>
  writeFile(path: string, content: string, options?: { worktreeId?: string }): Promise<void>
  searchText(query: string, options?: { worktreeId?: string }): AsyncIterable<SearchMatch>
}

export interface GroveClient {
  readonly apiVersion: string
  readonly grantedScopes: PluginPermission[]
  workspace: GroveClientWorkspace
  storage: {
    get<T>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }
  ai: {
    prompt(request: {
      prompt: string
      worktreeId?: string
      model?: string
      systemAppend?: string
    }): AsyncIterable<{ type: string; payload: unknown }>
  }
  editor: EditorApi
  git: GitApi
  agents: AgentsApi
  terminals: TerminalsApi
  languages: LanguagesApi
  services: ServicesApi
  events: {
    subscribe(
      topics: string[]
    ): AsyncIterable<{ topic: string; payload: unknown; worktreeId?: string }>
  }
  // Forward-compatible escape hatch for routes without a facade yet.
  raw: {
    request(method: string, params?: unknown): Promise<unknown>
    requestStream(method: string, params?: unknown): AsyncIterable<unknown>
  }
  close(): void
}

export async function connectGrove(options: ConnectOptions): Promise<GroveClient> {
  const socketPath = options.socketPath ?? discoverSocket()?.socketPath
  if (!socketPath) {
    throw new Error('no Grove socket found: is Grove running? (set GROVE_SOCK to override)')
  }
  const socket = await dial(socketPath)
  const decoder = new FrameDecoder()
  const endpoint = new RpcEndpoint((message: RpcMessage) => {
    socket.write(encodeFrame(message))
  }, 'odd')
  socket.on('data', (data) => {
    for (const message of decoder.push(data)) endpoint.handleMessage(message)
  })
  socket.on('close', () => endpoint.failAllPending('connection closed'))

  const hello: HelloParams = {
    appId: options.appId,
    name: options.name,
    version: options.version,
    requestedScopes: options.scopes,
    token: options.token ?? loadToken(options.appId)
  }
  const result = (await endpoint.request('api.hello', hello)) as HelloResult
  if (result.token) {
    if (options.onPairingToken) await options.onPairingToken(result.token)
    else saveToken(options.appId, result.token)
  }
  return buildClient(endpoint, socket, result)
}

function dial(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function buildClient(endpoint: RpcEndpoint, socket: Socket, hello: HelloResult): GroveClient {
  const request = (method: string, params: unknown = {}): Promise<unknown> =>
    endpoint.request(method, params)

  function stream<T>(method: string, params: unknown = {}): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]() {
        const queue: T[] = []
        let finished = false
        let failure: Error | null = null
        let wake: (() => void) | null = null
        const notify = (): void => {
          wake?.()
          wake = null
        }
        const handle = endpoint.requestStream(method, params, (chunk) => {
          if (Array.isArray(chunk)) queue.push(...(chunk as T[]))
          else queue.push(chunk as T)
          notify()
        })
        handle.done.then(
          () => {
            finished = true
            notify()
          },
          (error: Error) => {
            failure = error
            finished = true
            notify()
          }
        )
        return {
          async next(): Promise<IteratorResult<T>> {
            while (queue.length === 0 && !finished) {
              await new Promise<void>((resolve) => {
                wake = resolve
              })
            }
            if (queue.length > 0) return { value: queue.shift() as T, done: false }
            if (failure && failure.message !== 'cancelled') throw failure
            return { value: undefined as never, done: true }
          },
          async return(): Promise<IteratorResult<T>> {
            handle.cancel()
            finished = true
            return { value: undefined as never, done: true }
          }
        }
      }
    }
  }

  // Typed namespaces are thin proxies onto route method names — the server's
  // route registry (scopes, transports, streaming) is the authority.
  function namespaceProxy<T extends object>(prefix: string, streamingVerbs: string[] = []): T {
    return new Proxy({} as Record<string, unknown>, {
      get(_target, verb: string) {
        if (typeof verb !== 'string') return undefined
        if (streamingVerbs.includes(verb)) {
          return (params: unknown = {}) => stream(`${prefix}.${verb}`, params)
        }
        return (params: unknown = {}) => request(`${prefix}.${verb}`, params)
      }
    }) as T
  }

  return {
    apiVersion: hello.apiVersion,
    grantedScopes: hello.grantedScopes,

    workspace: {
      findFiles: (options) => request('workspace.findFiles', options) as Promise<string[]>,
      readFile: (path, options) =>
        request('workspace.readFile', { path, ...options }) as Promise<string>,
      readExcerpt: (path, startLine, endLine, options) =>
        request('workspace.readExcerpt', { path, startLine, endLine, ...options }) as Promise<
          { n: number; text: string }[]
        >,
      writeFile: (path, content, options) =>
        request('workspace.writeFile', { path, content, ...options }) as Promise<void>,
      searchText: (query, options) =>
        stream<SearchMatch>('workspace.searchText', { query, ...options })
    },

    storage: {
      get: <T>(key: string) => request('storage.get', { key }) as Promise<T | undefined>,
      set: (key, value) => request('storage.set', { key, value }) as Promise<void>,
      delete: (key) => request('storage.delete', { key }) as Promise<void>
    },

    ai: {
      prompt: (promptRequest) =>
        stream<{ type: string; payload: unknown }>('ai.prompt', promptRequest)
    },

    editor: buildEditor(request),
    git: buildGit(request),
    agents: buildAgents(request, stream),
    terminals: buildTerminals(request, stream),
    languages: namespaceProxy<LanguagesApi>('languages'),
    services: buildServices(request, stream),

    events: {
      subscribe: (topics) =>
        stream<{ topic: string; payload: unknown; worktreeId?: string }>('events.subscribe', {
          topics
        })
    },

    raw: {
      request: (method, params) => request(method, params ?? {}),
      requestStream: (method, params) => stream(method, params ?? {})
    },

    close: () => socket.destroy()
  }
}

type Request = (method: string, params?: unknown) => Promise<unknown>
type Stream = <T>(method: string, params?: unknown) => AsyncIterable<T>

function buildEditor(request: Request): EditorApi {
  return {
    listEditors: () => request('editor.listEditors') as ReturnType<EditorApi['listEditors']>,
    getActiveEditor: () =>
      request('editor.getActiveEditor') as ReturnType<EditorApi['getActiveEditor']>,
    openDocument: (path, options) =>
      request('editor.openDocument', { path, ...options }) as ReturnType<EditorApi['openDocument']>,
    readDocument: (path, options) =>
      request('editor.readDocument', { path, ...options }) as ReturnType<EditorApi['readDocument']>,
    getSelections: (path, options) =>
      request('editor.getSelections', { path, ...options }) as ReturnType<
        EditorApi['getSelections']
      >,
    applyEdit: (edit) => request('editor.applyEdit', edit) as ReturnType<EditorApi['applyEdit']>,
    save: (path, options) =>
      request('editor.save', { path, ...options }) as ReturnType<EditorApi['save']>,
    setSelections: (path, selections, options) =>
      request('editor.setSelections', { path, selections, ...options }) as ReturnType<
        EditorApi['setSelections']
      >,
    setDecorations: (key, path, decorations, options) =>
      request('editor.setDecorations', { key, path, decorations, ...options }) as Promise<void>,
    show: (path, options) => request('editor.show', { path, ...options }) as Promise<void>
  }
}

function buildGit(request: Request): GitApi {
  return {
    status: (options) => request('git.status', options) as ReturnType<GitApi['status']>,
    branches: (options) => request('git.branches', options) as ReturnType<GitApi['branches']>,
    diffFile: (path, options) =>
      request('git.diffFile', { path, ...options }) as ReturnType<GitApi['diffFile']>,
    fileAtRef: (path, ref, options) =>
      request('git.fileAtRef', { path, ref, ...options }) as Promise<string>,
    stage: (paths, options) =>
      request('git.stage', { paths, ...options }) as ReturnType<GitApi['stage']>,
    unstage: (paths, options) =>
      request('git.unstage', { paths, ...options }) as ReturnType<GitApi['unstage']>,
    commit: (message, options) =>
      request('git.commit', { message, ...options }) as ReturnType<GitApi['commit']>,
    push: (options) => request('git.push', options) as ReturnType<GitApi['push']>,
    worktrees: {
      list: () => request('git.worktrees.list') as ReturnType<GitApi['worktrees']['list']>,
      create: (options) =>
        request('git.worktrees.create', options) as ReturnType<GitApi['worktrees']['create']>,
      remove: (worktreeId) => request('git.worktrees.remove', { worktreeId }) as Promise<void>,
      archive: (worktreeId) => request('git.worktrees.archive', { worktreeId }) as Promise<void>
    },
    checkpoints: {
      list: (options) =>
        request('git.checkpoints.list', options) as ReturnType<GitApi['checkpoints']['list']>,
      snapshot: (options) =>
        request('git.checkpoints.snapshot', options) as ReturnType<
          GitApi['checkpoints']['snapshot']
        >,
      restore: (checkpointId, options) =>
        request('git.checkpoints.restore', { checkpointId, ...options }) as Promise<void>
    }
  }
}

function buildAgents(request: Request, stream: Stream): AgentsApi {
  return {
    listChats: (options) =>
      request('agents.listChats', options) as ReturnType<AgentsApi['listChats']>,
    listModels: () => request('agents.listModels') as ReturnType<AgentsApi['listModels']>,
    readTranscript: (chatId) =>
      request('agents.readTranscript', { chatId }) as ReturnType<AgentsApi['readTranscript']>,
    isRunning: (chatId) => request('agents.isRunning', { chatId }) as Promise<boolean>,
    observe: (chatId, token) => observeWithToken(stream, chatId, token),
    channelHistory: (options) =>
      request('agents.channelHistory', options) as ReturnType<AgentsApi['channelHistory']>,
    createChat: (options) =>
      request('agents.createChat', options) as ReturnType<AgentsApi['createChat']>,
    send: (chatId, message) => request('agents.send', { chatId, message }) as Promise<void>,
    stop: (chatId) => request('agents.stop', { chatId }) as Promise<void>,
    cancelQueued: (chatId, queueId) =>
      request('agents.cancelQueued', { chatId, queueId }) as Promise<void>,
    sendChannelMessage: (text, options) =>
      request('agents.sendChannelMessage', { text, ...options }) as Promise<void>
  }
}

function observeWithToken(
  stream: Stream,
  chatId: string,
  token?: CancellationToken
): ReturnType<AgentsApi['observe']> {
  const iterable = stream<{ type: string; payload: unknown }>('agents.observe', { chatId })
  if (!token) return iterable
  return {
    [Symbol.asyncIterator]() {
      const iterator = iterable[Symbol.asyncIterator]()
      token.onCancel(() => void iterator.return?.())
      return iterator
    }
  }
}

function buildTerminals(request: Request, stream: Stream): TerminalsApi {
  return {
    create: (options) =>
      request('terminals.create', options) as ReturnType<TerminalsApi['create']>,
    write: (terminalId, data) =>
      request('terminals.write', { terminalId, data }) as Promise<void>,
    resize: (terminalId, cols, rows) =>
      request('terminals.resize', { terminalId, cols, rows }) as Promise<void>,
    kill: (terminalId) => request('terminals.kill', { terminalId }) as Promise<void>,
    read: (terminalId) => stream<{ data: string }>('terminals.read', { terminalId })
  }
}

function buildServices(request: Request, stream: Stream): ServicesApi {
  return {
    list: (options) => request('services.list', options) as ReturnType<ServicesApi['list']>,
    readLogs: (serviceId, options) =>
      stream<{ line: string }>('services.readLogs', { serviceId, ...options }),
    start: (serviceId) => request('services.start', { serviceId }) as Promise<void>,
    stop: (serviceId) => request('services.stop', { serviceId }) as Promise<void>
  }
}
