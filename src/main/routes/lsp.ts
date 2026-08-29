// Language server requests, forwarded to the per-worktree LSP manager.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import type { LspPosition, LspRange, LspDiagnostic } from '../../shared/types'
import type { CodeAction, Diagnostic } from 'vscode-languageserver-protocol'

export const lspRoutes = {
  name: 'main/routes/lsp',
  inject: ['workbench', 'lsp'],

  apply(ctx: Context): void {
    // ── LSP ───────────────────────────────────────────────────────
    route(
      ctx,
      'lsp:ensure',
      (_e, worktreeId: string, language: string, uri: string, text: string) => {
        const worktree = ctx.workbench.findWorktree(worktreeId)
        return ctx.lsp.ensure(worktreeId, worktree.path, language, uri, text)
      }
    )
    route(
      ctx,
      'lsp:didChange',
      (_e, worktreeId: string, language: string, uri: string, version: number, text: string) =>
        ctx.lsp.didChange(worktreeId, language, uri, version, text)
    )
    route(
      ctx,
      'lsp:completion',
      (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
        ctx.lsp.completion(worktreeId, language, uri, position)
    )
    route(
      ctx,
      'lsp:hover',
      (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
        ctx.lsp.hover(worktreeId, language, uri, position)
    )
    route(
      ctx,
      'lsp:definition',
      (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
        ctx.lsp.definition(worktreeId, language, uri, position)
    )
    route(
      ctx,
      'lsp:references',
      (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
        ctx.lsp.references(worktreeId, language, uri, position)
    )
    route(
      ctx,
      'lsp:implementation',
      (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
        ctx.lsp.implementation(worktreeId, language, uri, position)
    )
    route(
      ctx,
      'lsp:typeDefinition',
      (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
        ctx.lsp.typeDefinition(worktreeId, language, uri, position)
    )
    route(
      ctx,
      'lsp:declaration',
      (_e, worktreeId: string, language: string, uri: string, position: LspPosition) =>
        ctx.lsp.declaration(worktreeId, language, uri, position)
    )
    route(
      ctx,
      'lsp:rename',
      (
        _e,
        worktreeId: string,
        language: string,
        uri: string,
        position: LspPosition,
        newName: string
      ) => ctx.lsp.rename(worktreeId, language, uri, position, newName)
    )
    route(
      ctx,
      'lsp:formatting',
      (_e, worktreeId: string, language: string, uri: string, tabSize: number) =>
        ctx.lsp.formatting(worktreeId, language, uri, tabSize)
    )
    route(
      ctx,
      'lsp:codeAction',
      (
        _e,
        worktreeId: string,
        language: string,
        uri: string,
        range: LspRange,
        diagnostics: LspDiagnostic[]
        // severity is a plain number over IPC; identical to DiagnosticSeverity.
      ) =>
        ctx.lsp.codeAction(worktreeId, language, uri, range, diagnostics as unknown as Diagnostic[])
    )
    route(
      ctx,
      'lsp:resolveCodeAction',
      (_e, worktreeId: string, language: string, action: CodeAction) =>
        ctx.lsp.resolveCodeAction(worktreeId, language, action)
    )
    route(
      ctx,
      'lsp:executeCommand',
      (_e, worktreeId: string, language: string, command: string, args: unknown[]) =>
        ctx.lsp.executeCommand(worktreeId, language, command, args)
    )
    route(
      ctx,
      'lsp:inlayHints',
      (_e, worktreeId: string, language: string, uri: string, range: LspRange) =>
        ctx.lsp.inlayHints(worktreeId, language, uri, range)
    )
  }
}
