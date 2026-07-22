// languages.* routes: LSP queries and mediated mutations. Documents are
// synced to the language server from the live editor buffer when one exists
// (falling back to disk), positions convert between the SDK's 1-based and
// LSP's 0-based conventions, and raw LSP objects never cross the boundary —
// code actions are cached behind short-lived host-minted actionIds bound to
// the document version they were queried at. Mutating verbs apply their
// WorkspaceEdit through the editor pipeline and therefore additionally
// require 'editor.edit'.

import { readFile } from 'fs/promises'
import { isAbsolute, join } from 'path'
import { pathToFileURL, fileURLToPath } from 'url'
import type { Worktree, LspPosition, LspRange } from '../../../shared/types'
import type { LspManager } from '../../lsp'
import type { CodeAction, Command, WorkspaceEdit, TextEdit } from 'vscode-languageserver-protocol'
import { detectLanguage } from '../../git'
import type { DocumentRegistry, RangedEdit } from '../../editorDocs'
import { ApiError, type RouteRegistry, type RouteContext } from '../registry'

export interface LanguagesRouteDeps {
  lsp: LspManager
  documents: DocumentRegistry
}

interface CachedAction {
  action: CodeAction | Command
  worktreeId: string
  language: string
  uri: string
  path: string
  version: number | null
}

const ACTION_CACHE_LIMIT = 200

export function registerLanguagesRoutes(registry: RouteRegistry, deps: LanguagesRouteDeps): void {
  const actionCache = new Map<string, CachedAction>()
  let actionCounter = 0

  interface Target {
    worktree: Worktree
    path: string
    absPath: string
    uri: string
    language: string
  }

  function targetOf(args: Record<string, unknown>, context: RouteContext): Target {
    const worktree = context.worktreeFor(args)
    const path = String(args.path ?? '')
    if (path.length === 0) throw new ApiError('path is required', 'invalid')
    const absPath = isAbsolute(path) ? path : join(worktree.path, path)
    return {
      worktree,
      path,
      absPath,
      uri: pathToFileURL(absPath).toString(),
      language: detectLanguage(path)
    }
  }

  // Sync the document into the server before querying: live buffer content
  // when the editor has it open, disk content otherwise.
  async function ensureSynced(target: Target): Promise<void> {
    let text: string
    try {
      const doc = await deps.documents.read(target.worktree.id, target.path)
      text = doc.lines.join('\n')
    } catch {
      text = await readFile(target.absPath, 'utf8')
    }
    await deps.lsp.ensure(target.worktree.id, target.worktree.path, target.language, target.uri, text)
  }

  function lspPosition(args: Record<string, unknown>): LspPosition {
    const position = args.position as { line?: number; column?: number } | undefined
    if (!position || typeof position.line !== 'number' || typeof position.column !== 'number') {
      throw new ApiError('position {line, column} is required', 'invalid')
    }
    return { line: position.line - 1, character: position.column - 1 }
  }

  function lspRange(args: Record<string, unknown>): LspRange {
    const range = args.range as
      | { start?: { line?: number; column?: number }; end?: { line?: number; column?: number } }
      | undefined
    if (!range?.start || !range?.end) throw new ApiError('range is required', 'invalid')
    return {
      start: { line: (range.start.line ?? 1) - 1, character: (range.start.column ?? 1) - 1 },
      end: { line: (range.end.line ?? 1) - 1, character: (range.end.column ?? 1) - 1 }
    }
  }

  function toLocations(
    locations: { uri: string; range: LspRange }[],
    worktree: Worktree
  ): unknown[] {
    return locations.map((location) => ({
      path: relativeToWorktree(worktree, location.uri),
      worktreeId: worktree.id,
      range: fromLspRange(location.range)
    }))
  }

  const query = (
    method: string,
    run: (target: Target, args: Record<string, unknown>) => Promise<unknown>
  ): void => {
    registry.register({
      method,
      scope: 'languages.read',
      handler: async (args, context) => {
        const target = targetOf(args, context)
        await ensureSynced(target)
        return run(target, args)
      }
    })
  }

  query('languages.hover', async (target, args) => {
    const contents = await deps.lsp.hover(target.worktree.id, target.language, target.uri, lspPosition(args))
    if (contents === null) return null
    return { contents }
  })

  const navigation: [string, 'definition' | 'references' | 'implementation' | 'typeDefinition'][] = [
    ['languages.definition', 'definition'],
    ['languages.references', 'references'],
    ['languages.implementation', 'implementation'],
    ['languages.typeDefinition', 'typeDefinition']
  ]
  for (const [method, verb] of navigation) {
    query(method, async (target, args) => {
      const locations = await deps.lsp[verb](
        target.worktree.id,
        target.language,
        target.uri,
        lspPosition(args)
      )
      return toLocations(locations as { uri: string; range: LspRange }[], target.worktree)
    })
  }

  query('languages.completion', async (target, args) => {
    const items = await deps.lsp.completion(target.worktree.id, target.language, target.uri, lspPosition(args))
    return items.map((item) => ({
      label: item.label,
      kind: String(item.kind ?? ''),
      detail: item.detail,
      insertText: item.insertText
    }))
  })

  query('languages.inlayHints', async (target, args) => {
    const hints = (await deps.lsp.inlayHints(
      target.worktree.id,
      target.language,
      target.uri,
      lspRange(args)
    )) as { position: LspPosition; label: unknown }[]
    return hints.map((hint) => ({
      position: { line: hint.position.line + 1, column: hint.position.character + 1 },
      label: flattenHintLabel(hint.label)
    }))
  })

  query('languages.codeActions', async (target, args) => {
    const actions = await deps.lsp.codeAction(
      target.worktree.id,
      target.language,
      target.uri,
      lspRange(args),
      []
    )
    const version = await currentVersion(deps.documents, target)
    return actions.map((action) => {
      actionCounter += 1
      const actionId = `action-${actionCounter}`
      actionCache.set(actionId, {
        action,
        worktreeId: target.worktree.id,
        language: target.language,
        uri: target.uri,
        path: target.path,
        version
      })
      pruneCache(actionCache)
      return {
        actionId,
        title: action.title,
        kind: (action as CodeAction).kind ?? 'command'
      }
    })
  })

  // ── Mutations: languages.read + editor.edit ───────────────────
  const mutation = (
    method: string,
    run: (target: Target, args: Record<string, unknown>, context: RouteContext) => Promise<unknown>
  ): void => {
    registry.register({
      method,
      scope: 'languages.read',
      handler: async (args, context) => {
        await context.broker.ensure(context.client, 'editor.edit', method)
        const target = targetOf(args, context)
        await ensureSynced(target)
        return run(target, args, context)
      }
    })
  }

  mutation('languages.rename', async (target, args) => {
    const expectedVersion = requiredVersion(args)
    const edit = await deps.lsp.rename(
      target.worktree.id,
      target.language,
      target.uri,
      lspPosition(args),
      String(args.newName ?? '')
    )
    if (!edit) throw new ApiError('rename produced no edit', 'invalid')
    return applyWorkspaceEdit(deps.documents, target, edit, expectedVersion)
  })

  mutation('languages.format', async (target, args) => {
    const expectedVersion = requiredVersion(args)
    const edits = await deps.lsp.formatting(target.worktree.id, target.language, target.uri, 2)
    if (edits.length === 0) return { status: 'applied', version: expectedVersion }
    return applyTextEdits(deps.documents, target.worktree.id, target.path, edits, expectedVersion)
  })

  registry.register({
    method: 'languages.applyCodeAction',
    scope: 'languages.read',
    handler: async (args, context) => {
      await context.broker.ensure(context.client, 'editor.edit', 'languages.applyCodeAction')
      const expectedVersion = requiredVersion(args)
      const cached = actionCache.get(String(args.actionId ?? ''))
      if (!cached) throw new ApiError('unknown or expired actionId', 'invalid')
      actionCache.delete(String(args.actionId))
      const resolved = await deps.lsp.resolveCodeAction(
        cached.worktreeId,
        cached.language,
        cached.action as CodeAction
      )
      const edit = (resolved as CodeAction | null)?.edit ?? (cached.action as CodeAction).edit
      if (!edit) throw new ApiError('code action has no applicable edit', 'unsupported')
      const worktree = context.worktreeFor({ worktreeId: cached.worktreeId })
      const target: Target = {
        worktree,
        path: cached.path,
        absPath: fileURLToPath(cached.uri),
        uri: cached.uri,
        language: cached.language
      }
      return applyWorkspaceEdit(deps.documents, target, edit, expectedVersion)
    }
  })
}

// Apply every file's edits through the editor pipeline. The initiating file
// is version-checked; other files apply at their current version (documented
// v1 limitation — no cross-buffer rollback).
async function applyWorkspaceEdit(
  documents: DocumentRegistry,
  target: { worktree: Worktree; path: string; uri: string },
  edit: WorkspaceEdit,
  expectedVersion: number
): Promise<unknown> {
  const changes = edit.changes ?? {}
  const changedFiles: string[] = []
  const entries = Object.entries(changes)
  // Initiating file first so a stale caller aborts before other files move.
  entries.sort(([uriA], [uriB]) => {
    if (uriA === target.uri) return -1
    if (uriB === target.uri) return 1
    return 0
  })
  for (const [uri, textEdits] of entries) {
    const path = relativeToWorktree(target.worktree, uri)
    const isInitiator = uri === target.uri
    const version = isInitiator
      ? expectedVersion
      : (await documents.open(target.worktree.id, path)).version
    const outcome = await applyTextEdits(documents, target.worktree.id, path, textEdits, version)
    if ((outcome as { status: string }).status === 'stale') return outcome
    changedFiles.push(path)
  }
  const last = await documents.open(target.worktree.id, target.path)
  return { status: 'applied', version: last.version, changedFiles }
}

async function applyTextEdits(
  documents: DocumentRegistry,
  worktreeId: string,
  path: string,
  edits: TextEdit[],
  expectedVersion: number
): Promise<unknown> {
  await documents.open(worktreeId, path)
  const ranged: RangedEdit[] = edits.map((edit) => ({
    range: {
      start: { line: edit.range.start.line + 1, column: edit.range.start.character + 1 },
      end: { line: edit.range.end.line + 1, column: edit.range.end.character + 1 }
    },
    newText: edit.newText
  }))
  return documents.applyEdit(worktreeId, path, expectedVersion, ranged)
}

async function currentVersion(
  documents: DocumentRegistry,
  target: { worktree: Worktree; path: string }
): Promise<number | null> {
  try {
    const doc = await documents.open(target.worktree.id, target.path)
    return doc.version
  } catch {
    return null
  }
}

function requiredVersion(args: Record<string, unknown>): number {
  const version = Number(args.expectedVersion)
  if (!Number.isFinite(version)) {
    throw new ApiError('expectedVersion is required', 'invalid')
  }
  return version
}

function relativeToWorktree(worktree: Worktree, uri: string): string {
  const absPath = uri.startsWith('file:') ? fileURLToPath(uri) : uri
  if (absPath.startsWith(worktree.path)) {
    return absPath.slice(worktree.path.length).replace(/^[/\\]/, '')
  }
  return absPath
}

function fromLspRange(range: LspRange): unknown {
  return {
    start: { line: range.start.line + 1, column: range.start.character + 1 },
    end: { line: range.end.line + 1, column: range.end.character + 1 }
  }
}

function flattenHintLabel(label: unknown): string {
  if (typeof label === 'string') return label
  if (Array.isArray(label)) {
    return label.map((part) => String((part as { value?: string }).value ?? '')).join('')
  }
  return String(label ?? '')
}

function pruneCache(cache: Map<string, CachedAction>): void {
  while (cache.size > ACTION_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) return
    cache.delete(oldest)
  }
}
