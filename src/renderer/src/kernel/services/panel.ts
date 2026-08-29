// The bottom panel as a host: it owns the panel pane and its tab strip, and
// other plugins contribute tabs into it. A tab renders an existing pane type as
// its body, so terminal, problems and plugin panes all show through one strip.

import type { Component } from 'svelte'
import { Service, type Context } from '@neoworks/extension-system'
import { panels } from '../../lib/panels.svelte'
import { panes } from '../../lib/panes.svelte'
import { layout } from '../../lib/layout.svelte'
import { CENTER_SLOT } from '../../lib/paneSlots'
import { repoOpen } from '../plugins/guards'
import TerminalWindow from 'phosphor-svelte/lib/TerminalWindow'
import BottomPanel from '../../components/BottomPanel.svelte'

export interface PanelTab {
  id: string
  title: string
  // Pane type rendered as this tab's body (resolved through the pane registry).
  paneTypeId: string
  icon?: Component
  order?: number
}

export class PanelService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'panel')
    this.registerPanelPane()
  }

  /** The panel pane itself: a tab strip rendering whichever tab is active. */
  private registerPanelPane(): void {
    this.ctx.effect(
      () =>
        panes.register({
          id: 'panel',
          title: 'Panel',
          icon: TerminalWindow,
          component: BottomPanel,
          slot: CENTER_SLOT,
          // Opens below the focused editor, like the problems pane.
          preferredOrientation: 'column',
          containerClass: 'bg-canvas',
          minHeight: 160,
          // The Terminal tab forwards keys to the shell ('terminal'); other tabs
          // run in 'normal'. The active tab reports which.
          modes: ['terminal', 'normal'],
          ownsFontScale: true,
          when: repoOpen
        }),
      'pane:panel'
    )
  }

  /** Register a tab in the bottom panel. Returns the inverse. */
  registerTab(tab: PanelTab): () => void {
    return panels.register(tab)
  }

  /** Show or hide the bottom panel. */
  toggle(): void {
    layout.togglePane('panel')
  }
}

declare module '@neoworks/extension-system' {
  interface Context {
    panel: PanelService
  }
}
