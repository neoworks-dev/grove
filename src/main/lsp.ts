// LSP manager. Spawns a language server (from an installed `lsp` extension) per
// (worktree, server), speaks LSP over stdio via vscode-jsonrpc, and exposes the
// operations the editor needs: document sync, completion, hover, and pushed
// diagnostics. Full-text document sync keeps it simple. Servers must be on PATH;
// a missing binary fails softly (no crash).

import { spawn, type ChildProcess } from 'child_process'
import { pathToFileURL } from 'url'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection
} from 'vscode-jsonrpc/node'
import {
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  PublishDiagnosticsNotification,
  CompletionRequest,
  HoverRequest,
  DefinitionRequest,
  ReferencesRequest,
  ImplementationRequest,
  TypeDefinitionRequest,
  DeclarationRequest,
  RenameRequest,
  DocumentFormattingRequest,
  CodeActionRequest,
  CodeActionResolveRequest,
  ExecuteCommandRequest,
  InlayHintRequest,
  type InitializeParams,
  type Diagnostic,
  type Hover,
  type CompletionItem,
  type Location,
  type LocationLink,
  type Definition,
  type WorkspaceEdit,
  type TextEdit,
  type Range,
  type CodeAction,
  type Command,
  type InlayHint
} from 'vscode-languageserver-protocol'
import { catalogEntry, listInstalled } from './extensions'
import type { CatalogEntry, LspCompletion, LspDiagnostic, LspPosition } from '../shared/types'

export interface LspEvents {
  onDiagnostics: (uri: string, diagnostics: LspDiagnostic[]) => void
}

interface Server {
  connection: MessageConnection
  child: ChildProcess
  ready: Promise<void>
  open: Set<string> // open document uris
  alive: boolean // false once the process/stream dies — never write again
}

async function lspEntryFor(language: string): Promise<CatalogEntry | null> {
  const installed = await listInstalled()
  for (const record of installed) {
    if (!record.enabled || record.kind !== 'lsp') continue
    const entry = catalogEntry(record.id)
    if (entry?.lsp?.languages.includes(language)) return entry
  }
  return null
}

function toLspDiagnostic(diagnostic: Diagnostic): LspDiagnostic {
  // message is `string | MarkupContent` in LSP 3.18.
  const message =
    typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value
  return {
    range: diagnostic.range,
    message,
    severity: diagnostic.severity,
    source: diagnostic.source
  }
}

function hoverToText(hover: Hover | null): string | null {
  if (!hover || !hover.contents) return null
  const contents = hover.contents
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents.map((part) => (typeof part === 'string' ? part : part.value)).join('\n\n')
  }
  // MarkupContent | MarkedString (object form) — both carry a string `value`.
  if (typeof contents === 'object' && 'value' in contents && typeof contents.value === 'string') {
    return contents.value
  }
  return null
}

export class LspManager {
  private servers = new Map<string, Server>()

  constructor(private events: LspEvents) {}

  private key(worktreeId: string, extId: string): string {
    return `${worktreeId}::${extId}`
  }

  private async serverFor(
    worktreeId: string,
    language: string
  ): Promise<Server | null> {
    const entry = await lspEntryFor(language)
    if (!entry?.lsp) return null
    return this.servers.get(this.key(worktreeId, entry.id)) || null
  }

  // Run a write only if the server is still alive, swallowing both a synchronous
  // throw and an async rejection from a destroyed stdio stream. Writing to a dead
  // server is the source of the ERR_STREAM_DESTROYED unhandled rejection.
  private safeSend(server: Server, send: () => Promise<unknown>): void {
    if (!server.alive || server.child.exitCode !== null || server.child.killed) return
    try {
      void send().catch(() => {})
    } catch {
      // stream already destroyed — nothing to do
    }
  }

  // Start (if needed) and open the document. Returns false if no server applies.
  async ensure(
    worktreeId: string,
    worktreePath: string,
    language: string,
    uri: string,
    text: string
  ): Promise<boolean> {
    const entry = await lspEntryFor(language)
    if (!entry?.lsp) return false
    const key = this.key(worktreeId, entry.id)
    let server: Server | null = this.servers.get(key) ?? null
    if (!server) {
      server = this.start(key, worktreePath, entry)
      if (!server) return false
    }
    try {
      await server.ready
    } catch {
      return false
    }
    if (!server.open.has(uri)) {
      server.open.add(uri)
      this.safeSend(server, () =>
        server!.connection.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: { uri, languageId: language, version: 1, text }
        })
      )
    }
    return true
  }

  private start(key: string, worktreePath: string, entry: CatalogEntry): Server | null {
    const lsp = entry.lsp!
    let child: ChildProcess
    try {
      child = spawn(lsp.command, lsp.args || [], {
        cwd: worktreePath,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch {
      return null
    }
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout!),
      new StreamMessageWriter(child.stdin!)
    )

    // Mark dead + drop from the map on any end-of-life signal, so no later write
    // hits a destroyed stream. Disposing the connection cancels pending handlers
    // and internal writes (server-initiated request replies) that would
    // otherwise reject with ERR_STREAM_DESTROYED after the stdio pipe dies.
    let dropped = false
    const drop = (): void => {
      if (dropped) return
      dropped = true
      const server = this.servers.get(key)
      if (server) server.alive = false
      this.servers.delete(key)
      try {
        connection.dispose()
      } catch {
        // already disposed
      }
    }
    child.on('error', drop)
    child.on('exit', drop)
    connection.onClose(drop)
    connection.onError(drop)

    connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      this.events.onDiagnostics(params.uri, params.diagnostics.map(toLspDiagnostic))
    })
    connection.listen()

    const rootUri = pathToFileURL(worktreePath).toString()
    const ready = (async () => {
      const params: InitializeParams = {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: 'root' }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            completion: { completionItem: { snippetSupport: false } },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            publishDiagnostics: {},
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            implementation: { dynamicRegistration: false },
            typeDefinition: { dynamicRegistration: false },
            declaration: { dynamicRegistration: false },
            rename: { dynamicRegistration: false },
            formatting: { dynamicRegistration: false },
            codeAction: {
              dynamicRegistration: false,
              resolveSupport: { properties: ['edit'] }
            },
            inlayHint: { dynamicRegistration: false }
          }
        }
      }
      await connection.sendRequest(InitializeRequest.type, params)
      void connection.sendNotification(InitializedNotification.type, {}).catch(() => {})
    })()

    const server: Server = { connection, child, ready, open: new Set(), alive: true }
    this.servers.set(key, server)
    ready.catch(() => drop())
    return server
  }

  async didChange(
    worktreeId: string,
    language: string,
    uri: string,
    version: number,
    text: string
  ): Promise<void> {
    const server = await this.serverFor(worktreeId, language)
    if (!server || !server.open.has(uri)) return
    this.safeSend(server, () =>
      server.connection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version },
        contentChanges: [{ text }] // full-document sync
      })
    )
  }

  async completion(
    worktreeId: string,
    language: string,
    uri: string,
    position: LspPosition
  ): Promise<LspCompletion[]> {
    const server = await this.serverFor(worktreeId, language)
    if (!server || !server.alive) return []
    const result = await server.connection
      .sendRequest(CompletionRequest.type, { textDocument: { uri }, position })
      .catch(() => null)
    const items: CompletionItem[] = Array.isArray(result) ? result : result?.items || []
    return items.slice(0, 200).map((item) => ({
      label: item.label,
      detail: item.detail,
      kind: item.kind,
      insertText: item.insertText || item.textEdit?.newText || item.label
    }))
  }

  async hover(
    worktreeId: string,
    language: string,
    uri: string,
    position: LspPosition
  ): Promise<string | null> {
    const server = await this.serverFor(worktreeId, language)
    if (!server || !server.alive) return null
    const hover = await server.connection
      .sendRequest(HoverRequest.type, { textDocument: { uri }, position })
      .catch(() => null)
    return hoverToText(hover as Hover | null)
  }

  // ── Navigation (definition, references, implementation, …) ──────
  // Normalize the server's Location | Location[] | LocationLink[] into a flat
  // Location list. LocationLink carries the target on `targetUri`/`targetRange`.
  private toLocations(result: Definition | LocationLink[] | null): Location[] {
    if (!result) return []
    const items = Array.isArray(result) ? result : [result]
    return items.map((item) => {
      if ('targetUri' in item) {
        return { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange }
      }
      return item
    })
  }

  private async locationRequest(
    type:
      | typeof DefinitionRequest.type
      | typeof ImplementationRequest.type
      | typeof TypeDefinitionRequest.type
      | typeof DeclarationRequest.type,
    worktreeId: string,
    language: string,
    uri: string,
    position: LspPosition
  ): Promise<Location[]> {
    const server = await this.serverFor(worktreeId, language)
    if (!server || !server.alive) return []
    const result = await server.connection
      .sendRequest(type, { textDocument: { uri }, position })
      .catch(() => null)
    return this.toLocations(result as Definition | LocationLink[] | null)
  }

  async definition(
    worktreeId: string,
    language: string,
    uri: string,
    position: LspPosition
  ): Promise<Location[]> {
    return this.locationRequest(DefinitionRequest.type, worktreeId, language, uri, position)
  }

  async implementation(
    worktreeId: string,
    language: string,
    uri: string,
    position: LspPosition
  ): Promise<Location[]> {
    return this.locationRequest(ImplementationRequest.type, worktreeId, language, uri, position)
  }

  async typeDefinition(
    worktreeId: string,
    language: string,
    uri: string,
    position: LspPosition
  ): Promise<Location[]> {
    return this.locationRequest(TypeDefinitionRequest.type, worktreeId, language, uri, position)
  }

  async declaration(
    worktreeId: string,
    language: string,
    uri: string,
    position: LspPosition
  ): Promise<Location[]> {
    return this.locationRequest(DeclarationRequest.type, worktreeId, language, uri, position)
  }

  async references(
    worktreeId: string,
    language: string,
    uri: string,
    position: LspPosition
  ): Promise<Location[]> {
    const server = await this.serverFor(worktreeId, language)
    if (!server || !server.alive) return []
    const result = await server.connection
      .sendRequest(ReferencesRequest.type, {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true }
      })
      .catch(() => null)
    return Array.isArray(result) ? result : []
  }

  // ── Refactor (rename, format, code action) ──────────────────────
  async rename(
    worktreeId: string,
    language: string,
    uri: string,
    position: LspPosition,
    newName: string
  ): Promise<WorkspaceEdit | null> {
    const server = await this.serverFor(worktreeId, language)
    if (!server || !server.alive) return null
    return server.connection
      .sendRequest(RenameRequest.type, { textDocument: { uri }, position, newName })
      .catch(() => null)
  }

  async formatting(
    worktreeId: string,
    language: string,
    uri: string,
    tabSize: number
  ): Promise<TextEdit[]> {
    const server = await this.serverFor(worktreeId, language)
    if (!server || !server.alive) return []
    const result = await server.connection
      .sendRequest(DocumentFormattingRequest.type, {
        textDocument: { uri },
        options: { tabSize, insertSpaces: true }
      })
      .catch(() => null)
    return Array.isArray(result) ? result : []
  }

  async codeAction(
    worktreeId: string,
    language: string,
    uri: string,
    range: Range,
    diagnostics: Diagnostic[]
  ): Promise<(Command | CodeAction)[]> {
    const server = await this.serverFor(worktreeId, language)
    if (!server || !server.alive) return []
    const result = await server.connection
      .sendRequest(CodeActionRequest.type, {
        textDocument: { uri },
        range,
        context: { diagnostics }
      })
      .catch(() => null)
    return Array.isArray(result) ? result : []
  }

  // Resolve a code action's edit when the server deferred it (resolveSupport).
  async resolveCodeAction(
    worktreeId: string,
    language: string,
    action: CodeAction
  ): Promise<CodeAction> {
    const server = await this.serverFor(worktreeId, language)
    if (!server || !server.alive) return action
    const resolved = await server.connection
      .sendRequest(CodeActionResolveRequest.type, action)
      .catch(() => null)
    return resolved ?? action
  }

  // ── Inlay hints (inline type/parameter annotations) ─────────────
  async inlayHints(
    worktreeId: string,
    language: string,
    uri: string,
    range: Range
  ): Promise<InlayHint[]> {
    const server = await this.serverFor(worktreeId, language)
    if (!server || !server.alive) return []
    const result = await server.connection
      .sendRequest(InlayHintRequest.type, { textDocument: { uri }, range })
      .catch(() => null)
    return Array.isArray(result) ? result : []
  }

  // Run a server command (code actions that are Commands rather than edits).
  async executeCommand(
    worktreeId: string,
    language: string,
    command: string,
    args: unknown[]
  ): Promise<void> {
    const server = await this.serverFor(worktreeId, language)
    if (!server || !server.alive) return
    await server.connection
      .sendRequest(ExecuteCommandRequest.type, { command, arguments: args })
      .catch(() => null)
  }

  stopAll(): void {
    for (const server of this.servers.values()) {
      server.alive = false
      try {
        server.connection.dispose()
      } catch {
        // ignore
      }
      server.child.kill()
    }
    this.servers.clear()
  }
}
