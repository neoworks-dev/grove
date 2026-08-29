// The sidebar as a host: it owns the left rail and the left dock, and other
// plugins contribute views into it. A contributor declares `inject: ['sidebar']`,
// so it only runs while the sidebar exists and its view disappears with it.
//
// The whole surface lives in this directory: this service, the rail-launcher
// registry (`launchers.svelte.ts`) and the rail itself (`ActivityBar.svelte`).
// Each contributed view is its own sibling plugin directory.

import type { Component } from 'svelte'
import { Service, type Context } from '@neoworks/extension-system'
import { panes } from '../../../lib/panes.svelte'
import { sidebar as railLaunchers, type RailLauncher } from './launchers.svelte'
import { layout } from '../../../lib/layout.svelte'
import { SIDEBAR_SLOT } from '../../../lib/paneSlots'

export interface SidebarView {
  id: string
  title: string
  // Rail icon (phosphor component).
  icon: Component
  // Position in the rail; lower comes first.
  order: number
  component: Component
  containerClass?: string
  minWidth?: number
  // When false the view shows the "open a repository" placeholder.
  when?: () => boolean
}

export class SidebarService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sidebar')
  }

  /**
   * Register a sidebar view: a pane in the sidebar slot plus its rail icon.
   * Returns the inverse, so callers wrap it in `ctx.effect`.
   */
  registerView(view: SidebarView): () => void {
    return panes.register({
      id: view.id,
      title: view.title,
      icon: view.icon,
      component: view.component,
      rail: { order: view.order },
      slot: SIDEBAR_SLOT,
      containerClass: view.containerClass || 'bg-elevated',
      minWidth: view.minWidth || 180,
      when: view.when
    })
  }

  /** Rail icon that runs an action instead of surfacing a view. */
  registerLauncher(launcher: RailLauncher): () => void {
    return railLaunchers.register(launcher)
  }

  /** Reveal a registered view in the left dock. */
  show(viewId: string): void {
    layout.showInDock('left', viewId)
  }
}

declare module '@neoworks/extension-system' {
  interface Context {
    sidebar: SidebarService
  }
}
