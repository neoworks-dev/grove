// Design system: a specimen pane for the @neoworks-dev/ui primitives, opened
// beside the editor from the pane rail or the palette.

import type { Context } from '@neoworks/extension-system'
import PaletteIcon from 'phosphor-svelte/lib/PaletteIcon'
import DesignSystemPane from './DesignSystemPane.svelte'

export const designSystem = {
  name: 'core/design-system',
  inject: ['editor'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.editor.registerAuxPane({
          id: 'design-system',
          title: 'Design System',
          icon: PaletteIcon,
          component: DesignSystemPane,
          orientation: 'row',
          containerClass: 'bg-surface',
          minWidth: 360,
          keywords: 'design system components ui specimen buttons select'
        }),
      'pane:design-system'
    )
  }
}
