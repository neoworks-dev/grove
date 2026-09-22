<script lang="ts">
  // A branch, remote branch, tag or detached HEAD label on a graph row. Its
  // menu (right-click) is the same one the source-control view's rows offer;
  // double-clicking a branch checks it out.
  import GitBranchIcon from 'phosphor-svelte/lib/GitBranchIcon'
  import CloudIcon from 'phosphor-svelte/lib/CloudIcon'
  import TagIcon from 'phosphor-svelte/lib/TagIcon'
  import TreeViewIcon from 'phosphor-svelte/lib/TreeViewIcon'
  import CrosshairIcon from 'phosphor-svelte/lib/CrosshairIcon'
  import ContextMenu, { type MenuItem } from '../../../components/ContextMenu.svelte'
  import {
    branchMenu,
    checkedOutElsewhere,
    checkoutOrOpen,
    tagMenu,
    type RefMenuContext
  } from '../gitChanges/refMenus'
  import type { RefLabel } from './refLabels'

  let {
    label,
    context,
    colour
  }: {
    label: RefLabel
    context: RefMenuContext
    /** The lane colour of the commit it labels. */
    colour: string
  } = $props()

  let menu = $state<{ x: number; y: number } | null>(null)

  const current = $derived(label.kind === 'branch' && label.branch.current)
  const elsewhere = $derived(
    label.kind === 'branch' && checkedOutElsewhere(label.branch, context.worktreePath)
  )

  /** Opens the label's menu at the pointer. */
  function openMenu(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    if (label.kind === 'head') return
    menu = { x: event.clientX, y: event.clientY }
  }

  /** The label's menu items. */
  function menuItems(): MenuItem[] {
    if (label.kind === 'tag') return tagMenu(context, label.tag)
    if (label.kind === 'head') return []
    return branchMenu(context, label.branch)
  }

  /** Checks a branch out on double-click. */
  function checkout(event: MouseEvent): void {
    event.stopPropagation()
    if (label.kind !== 'branch' && label.kind !== 'remote') return
    if (label.branch.current) return
    checkoutOrOpen(context, label.branch)
  }

  /** The tooltip: what kind of ref it is, and where a branch is checked out. */
  function details(): string {
    if (label.kind === 'head') return 'HEAD, detached'
    if (label.kind === 'tag') return `tag ${label.name}`
    if (label.kind === 'remote') return `remote branch ${label.name}`
    if (current) return `${label.name}, checked out here`
    if (elsewhere) return `${label.name}, checked out in ${label.branch.worktreePath}`
    return `branch ${label.name}`
  }
</script>

<span
  class="inline-flex h-4 max-w-40 shrink-0 items-center gap-1 rounded-sm border-l-2 bg-raised px-1 text-2xs text-default"
  class:font-semibold={current}
  style:border-left-color={colour}
  role="button"
  tabindex="-1"
  title={details()}
  oncontextmenu={openMenu}
  ondblclick={checkout}
>
  {#if label.kind === 'head'}
    <CrosshairIcon size={10} class="shrink-0" />
  {:else if label.kind === 'tag'}
    <TagIcon size={10} class="shrink-0 text-dim" />
  {:else if label.kind === 'remote'}
    <CloudIcon size={10} class="shrink-0 text-dim" />
  {:else if elsewhere}
    <TreeViewIcon size={10} class="shrink-0 text-dim" />
  {:else}
    <GitBranchIcon size={10} class="shrink-0 text-dim" />
  {/if}
  <span class="truncate">{label.name}</span>
</span>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => (menu = null)} />
{/if}
