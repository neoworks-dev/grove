// Base view definitions — named layouts shown in the header. Plugins register
// theirs through the same registry.

import { views } from './views.svelte'
import { buildDefaultTree } from './layout.svelte'
import { createLeaf, createSplit } from './layoutTree'

export function registerCoreViews(): void {
  views.register({
    id: 'code',
    label: 'Code',
    order: 1,
    buildTree: () => buildDefaultTree(),
    initialFocus: 'nvim'
  })
  views.register({
    id: 'review',
    label: 'Review',
    order: 2,
    buildTree: () => createSplit('row', [createLeaf('diff'), createLeaf('agent')], [0.72, 0.28]),
    initialFocus: 'diff'
  })
  views.register({
    id: 'preview',
    label: 'Preview',
    order: 3,
    buildTree: () => createLeaf('preview')
  })
  views.register({
    id: 'dashboard',
    label: 'Dashboard',
    order: 4,
    buildTree: () => createLeaf('dashboard')
  })
}
