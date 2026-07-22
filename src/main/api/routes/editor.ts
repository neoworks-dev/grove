// editor.* routes: nvim-backed documents with optimistic concurrency. All
// buffer state flows through the DocumentRegistry (atomic lua check-and-
// apply); this module only handles scope gating, argument shaping, and the
// worktree prison check on paths.

import { isAbsolute, join, resolve } from 'path'
import { isInside } from '../broker'
import type { DocumentRegistry, RangedEdit, Position } from '../../editorDocs'
import { ApiError, type RouteRegistry, type RouteContext } from '../registry'

export interface EditorRouteDeps {
  documents: DocumentRegistry
  // Ask the renderer to reveal a file (focus/scroll); UI-side effect only.
  openInEditor: (worktreeId: string, path: string, line?: number) => void
}

export function registerEditorRoutes(registry: RouteRegistry, deps: EditorRouteDeps): void {
  registry.register({
    method: 'editor.listEditors',
    scope: 'editor.read',
    handler: async () => deps.documents.listEditors()
  })

  registry.register({
    method: 'editor.getActiveEditor',
    scope: 'editor.read',
    handler: async () => deps.documents.getActiveEditor()
  })

  registry.register({
    method: 'editor.openDocument',
    scope: 'editor.read',
    handler: async (args, context) => {
      const { worktree, path } = target(args, context)
      return deps.documents.open(worktree.id, path)
    }
  })

  registry.register({
    method: 'editor.readDocument',
    scope: 'editor.read',
    handler: async (args, context) => {
      const { worktree, path } = target(args, context)
      return deps.documents.read(worktree.id, path)
    }
  })

  registry.register({
    method: 'editor.getSelections',
    scope: 'editor.read',
    handler: async (args, context) => {
      const { worktree, path } = target(args, context)
      return deps.documents.getSelections(worktree.id, path)
    }
  })

  registry.register({
    method: 'editor.applyEdit',
    scope: 'editor.edit',
    handler: async (args, context) => {
      const { worktree, path } = target(args, context)
      const expectedVersion = Number(args.expectedVersion)
      if (!Number.isFinite(expectedVersion)) {
        throw new ApiError('editor.applyEdit requires expectedVersion', 'invalid')
      }
      const edits = args.edits
      if (!Array.isArray(edits) || edits.length === 0) {
        throw new ApiError('editor.applyEdit requires a non-empty edits array', 'invalid')
      }
      return deps.documents.applyEdit(worktree.id, path, expectedVersion, edits as RangedEdit[])
    }
  })

  registry.register({
    method: 'editor.save',
    scope: 'editor.edit',
    handler: async (args, context) => {
      const { worktree, path } = target(args, context)
      return deps.documents.save(worktree.id, path, optionalNumber(args.expectedVersion))
    }
  })

  registry.register({
    method: 'editor.setSelections',
    scope: 'editor.edit',
    handler: async (args, context) => {
      const { worktree, path } = target(args, context)
      const selections = args.selections
      if (!Array.isArray(selections) || selections.length === 0) {
        throw new ApiError('editor.setSelections requires selections', 'invalid')
      }
      return deps.documents.setSelections(
        worktree.id,
        path,
        selections as { start: Position; end: Position }[],
        optionalNumber(args.expectedVersion)
      )
    }
  })

  registry.register({
    method: 'editor.setDecorations',
    scope: 'editor.edit',
    handler: async (args, context) => {
      const { worktree, path } = target(args, context)
      const key = String(args.key ?? '')
      if (key.length === 0) throw new ApiError('decoration key is required', 'invalid')
      const decorations = Array.isArray(args.decorations) ? args.decorations : []
      await deps.documents.setDecorations(
        worktree.id,
        path,
        `${context.client.key}:${key}`,
        decorations as { range: { start: Position; end: Position }; style: string }[]
      )
    }
  })

  registry.register({
    method: 'editor.show',
    scope: 'editor.edit',
    handler: async (args, context) => {
      const { worktree, path } = target(args, context)
      deps.openInEditor(worktree.id, path, optionalNumber(args.line))
    }
  })
}

// Resolve and prison-check the path: editor routes are worktree-confined
// (no fsScopes escape hatch — that is a workspace.* concept).
function target(
  args: Record<string, unknown>,
  context: RouteContext
): { worktree: { id: string; path: string }; path: string } {
  const worktree = context.worktreeFor(args)
  const rawPath = String(args.path ?? '')
  if (rawPath.length === 0) throw new ApiError('path is required', 'invalid')
  const absPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(join(worktree.path, rawPath))
  if (!isInside(worktree.path, absPath)) {
    throw new ApiError('path escapes the worktree', 'permission-denied')
  }
  return { worktree, path: rawPath }
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  return Number(value)
}
