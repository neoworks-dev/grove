<script lang="ts">
  // One local or remote-tracking branch. The row shows where it stands against
  // its upstream and how recently it moved; hover offers checking it out, and
  // the menu (the ⋯ button, or a right-click) everything else. A branch checked
  // out in another worktree cannot be checked out here — git refuses — so it
  // offers switching to that worktree instead.
  import GitBranchIcon from 'phosphor-svelte/lib/GitBranchIcon'
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon'
  import SignInIcon from 'phosphor-svelte/lib/SignInIcon'
  import TreeViewIcon from 'phosphor-svelte/lib/TreeViewIcon'
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon'
  import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon'
  import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon'
  import ContextMenu, { type MenuItem } from '../../../components/ContextMenu.svelte'
  import RowAction from './RowAction.svelte'
  import { relativeTime } from '../../../lib/time'
  import { compareRefs } from './compareTarget.svelte'
  import {
    checkoutBranch,
    copyText,
    deleteBranch,
    mergeIntoCurrent,
    openBranchWorktree,
    rebaseCurrentOnto
  } from './refActions'
  import type { BranchRef } from '../../../../../shared/types'

  let {
    worktreeId,
    worktreePath,
    branch,
    currentBranch,
    onChanged
  }: {
    worktreeId: string
    worktreePath: string
    branch: BranchRef
    currentBranch: string
    onChanged: () => void
  } = $props()

  let menu = $state<{ x: number; y: number } | null>(null)

  // Checked out somewhere other than the worktree on screen.
  const elsewhere = $derived(
    branch.worktreePath !== null && branch.worktreePath !== worktreePath && !branch.current
  )
  const local = $derived(branch.remote === null)

  /** Runs an action and reloads the view when it changed anything. */
  async function run(action: () => Promise<boolean>): Promise<void> {
    if (await action()) onChanged()
  }

  /** Checks the branch out here, or goes to the worktree that has it. */
  function checkout(): void {
    if (elsewhere) {
      openBranchWorktree(branch)
      return
    }
    void run(() => checkoutBranch(worktreeId, branch))
  }

  /** Opens the menu at the pointer. */
  function openMenu(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    menu = { x: event.clientX, y: event.clientY }
  }

  /** Everything the menu offers for this branch, in the order it offers it. */
  function menuItems(): MenuItem[] {
    const items: MenuItem[] = []
    if (!branch.current) {
      items.push({ label: checkoutLabel(), action: checkout })
      items.push({
        label: `Merge into ${currentBranch}`,
        action: () => void run(() => mergeIntoCurrent(worktreeId, branch.name))
      })
      items.push({
        label: `Rebase ${currentBranch} onto ${branch.name}`,
        action: () => void run(() => rebaseCurrentOnto(worktreeId, currentBranch, branch.name))
      })
      items.push({ divider: true })
      items.push({ label: 'Compare with HEAD', action: () => compareRefs(branch.name, 'HEAD') })
    }
    items.push({ label: 'Compare with working tree', action: () => compareRefs(branch.name, null) })
    items.push({ divider: true })
    items.push({ label: 'Copy name', action: () => copyText(branch.name) })
    if (local && !branch.current && branch.worktreePath === null) {
      items.push({ divider: true })
      items.push({
        label: 'Delete branch',
        danger: true,
        action: () => void run(() => deleteBranch(worktreeId, branch))
      })
    }
    return items
  }

  /** What checking out does for this branch. */
  function checkoutLabel(): string {
    if (elsewhere) return 'Open its worktree'
    return 'Checkout'
  }

  /** The tooltip: last commit, upstream, and where it is checked out. */
  function details(): string {
    const lines = [`${branch.name} · ${new Date(branch.date).toLocaleString()}`, branch.subject]
    if (branch.upstream) lines.push(`tracks ${branch.upstream}`)
    if (branch.upstreamGone) lines.push('its upstream was deleted')
    if (elsewhere) lines.push(`checked out in ${branch.worktreePath}`)
    return lines.join('\n')
  }
</script>

<div
  class="group/row flex w-full cursor-default items-center gap-1 py-[3px] pr-2 pl-1 text-xs select-none hover:bg-hover"
  class:text-default={branch.current}
  class:text-muted={!branch.current}
  role="treeitem"
  tabindex="-1"
  aria-selected={branch.current}
  aria-label={branch.name}
  title={details()}
  oncontextmenu={openMenu}
  ondblclick={() => !branch.current && checkout()}
>
  <span class="w-3 shrink-0"></span>
  <span class="grid w-4 shrink-0 place-items-center text-dim">
    {#if branch.current}
      <CheckIcon size={12} class="text-green" />
    {:else if elsewhere}
      <TreeViewIcon size={12} />
    {:else}
      <GitBranchIcon size={12} />
    {/if}
  </span>
  <span class="min-w-0 flex-1 truncate" class:font-medium={branch.current}>{branch.name}</span>

  <div class="hidden shrink-0 items-center group-hover/row:flex">
    {#if !branch.current}
      <RowAction icon={SignInIcon} title={checkoutLabel()} onclick={checkout} />
    {/if}
    <RowAction icon={DotsThreeIcon} title="More actions" onclick={openMenu} />
  </div>

  <span class="flex shrink-0 items-center gap-1 font-mono text-2xs text-dim group-hover/row:hidden">
    {#if branch.upstreamGone}
      <span class="text-amber">gone</span>
    {/if}
    {#if branch.ahead > 0}
      <span class="flex items-center"><ArrowUpIcon size={10} />{branch.ahead}</span>
    {/if}
    {#if branch.behind > 0}
      <span class="flex items-center"><ArrowDownIcon size={10} />{branch.behind}</span>
    {/if}
    <span>{relativeTime(branch.date)}</span>
  </span>
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => (menu = null)} />
{/if}
