// Base view definitions — named layouts shown in the header. Plugins register
// theirs through the same registry.

import { views } from './views.svelte'
import { buildDefaultTree } from './layout.svelte'
import { createLeaf } from './layoutTree'

export function registerCoreViews(): void {
  views.register({
    id: 'code',
    label: 'Code',
    order: 1,
    buildTree: () => buildDefaultTree(),
    initialFocus: 'nvim'
  })
  // Views define only the center split tree now; the agent panel lives in the
  // right dock, shared across views. Git changes review happens in the editor
  // (floating hunk overlay) driven from the Git Changes sidebar, so there is no
  // dedicated review/preview center view.
  views.register({
    id: 'dashboard',
    label: 'Dashboard',
    order: 2,
    buildTree: () => createLeaf('dashboard')
  })
}
