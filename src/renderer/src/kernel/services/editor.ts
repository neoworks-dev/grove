// The editor as a host: it owns the Neovim panes in the center slot and the
// panes that open beside them, and it is how any plugin reaches the buffer the
// user is looking at without importing the nvim session registry itself.

import type { Component } from 'svelte'
import { Service, type Context } from '@neoworks/extension-system'
import { panes } from '../../lib/panes.svelte'
import { store, openFileInEditor, openFileAtLine } from '../../lib/store.svelte'
import { activeNvimSession } from '../../lib/nvim/registry'
import type { NvimCanvasSession } from '../../lib/nvim/session'
import { CENTER_SLOT } from '../../lib/paneSlots'
import { repoOpen } from '../plugins/guards'
import NvimPane from '../../components/NvimPane.svelte'
import NvimGridPane from '../../components/NvimGridPane.svelte'
import EmptyCenter from '../../components/EmptyCenter.svelte'

// Editor-family modes, reported live from the embedded nvim's mode_change events.
const NVIM_MODES = ['normal', 'insert', 'visual', 'replace', 'cmdline', 'operator', 'terminal']

export interface EditorAuxPane {
  id: string
  title: string
  component: Component
  icon?: Component
  // Which way revealing this pane splits the focused editor leaf.
  orientation: 'row' | 'column'
  // Join the center slot, so this pane and the editor replace each other rather
  // than stacking. Settings-family panes leave it off: taking the slot swapped
  // the editor out and nothing in those panes put it back.
  centerSlot?: boolean
  containerClass?: string
  minWidth?: number
  minHeight?: number
  when?: () => boolean
}

export class EditorService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'editor')
    this.registerEditorPanes()
  }

  /**
   * The panes the editor itself owns: the Neovim surface, a single Neovim
   * window (multigrid), and the placeholder an empty center leaf shows.
   */
  private registerEditorPanes(): void {
    this.ctx.effect(
      () =>
        panes.register({
          id: 'nvim',
          title: 'Neovim',
          component: NvimPane,
          slot: CENTER_SLOT,
          containerClass: 'bg-surface',
          minWidth: 240,
          // Reports the 'editor' keymap context so editor-scoped bindings (file
          // finder, etc.) match here.
          contextType: 'editor',
          modes: NVIM_MODES,
          ownsFontScale: true,
          when: repoOpen
        }),
      'pane:nvim'
    )

    this.ctx.effect(
      () =>
        panes.register({
          id: 'nvim-grid',
          title: 'Neovim Window',
          component: NvimGridPane,
          containerClass: 'bg-surface',
          minWidth: 120,
          minHeight: 80,
          contextType: 'editor',
          modes: NVIM_MODES,
          ownsFontScale: true,
          when: repoOpen
        }),
      'pane:nvim-grid'
    )

    // Renders its own empty state, so no `when` guard: it must show even before
    // a repository is open.
    this.ctx.effect(
      () =>
        panes.register({
          id: 'empty',
          title: 'Empty',
          component: EmptyCenter,
          slot: CENTER_SLOT,
          minWidth: 240
        }),
      'pane:empty'
    )
  }

  /**
   * Register a pane that opens beside the editor rather than replacing it
   * (markdown preview, problems, the settings family). Returns the inverse.
   */
  registerAuxPane(pane: EditorAuxPane): () => void {
    return panes.register({
      id: pane.id,
      title: pane.title,
      icon: pane.icon,
      component: pane.component,
      preferredOrientation: pane.orientation,
      slot: pane.centerSlot ? CENTER_SLOT : undefined,
      containerClass: pane.containerClass,
      minWidth: pane.minWidth,
      minHeight: pane.minHeight,
      when: pane.when
    })
  }

  /** Open a file in the editor, optionally revealing a line. */
  open(path: string, options: { worktreeId?: string; line?: number } = {}): void {
    const worktreeId = options.worktreeId || store.selectedWorktreeId
    if (!worktreeId) return
    if (typeof options.line === 'number') {
      openFileAtLine(worktreeId, path, options.line)
      return
    }
    openFileInEditor(worktreeId, path)
  }

  /** The Neovim session backing the focused editor leaf, if one is mounted. */
  activeSession(): NvimCanvasSession | undefined {
    return activeNvimSession()
  }
}

declare module '@neoworks/extension-system' {
  interface Context {
    editor: EditorService
  }
}
