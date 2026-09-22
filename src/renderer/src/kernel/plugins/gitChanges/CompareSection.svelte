<script lang="ts">
  // Any two refs side by side, or a ref against the working tree: the commits
  // each has that the other lacks, and every file that differs. A file opens as
  // its diff — between the two revisions, or with the real, editable file on
  // the right when the head is the working tree.
  //
  // Set from the two pickers, or from a branch or tag's "compare with" menu,
  // which opens this section and scrolls it into view.
  import Select from '@neoworks-dev/ui/Select'
  import ArrowsLeftRightIcon from 'phosphor-svelte/lib/ArrowsLeftRightIcon'
  import CommitFileRow from './CommitFileRow.svelte'
  import CommitRow from './CommitRow.svelte'
  import GitSection from './GitSection.svelte'
  import RowAction from './RowAction.svelte'
  import { store } from '../../../lib/store.svelte'
  import { openRevisionDiff, openWorkingTreeDiff } from '../../../lib/nvim/revisionDiff'
  import { compareTarget, compareRefs } from './compareTarget.svelte'
  import type { DiffFile, RefComparison, RefList } from '../../../../../shared/types'

  let {
    worktreeId,
    worktreePath,
    refreshKey
  }: {
    worktreeId: string
    worktreePath: string
    refreshKey: number
  } = $props()

  // The head picker's value for the working tree; git has no name for it.
  const WORKING_TREE = ''

  let refs = $state<RefList>({ local: [], remote: [], tags: [] })
  let result = $state<RefComparison | null>(null)
  let open = $state(false)
  let sectionElement = $state<HTMLDivElement>()
  let showAhead = $state(true)
  let showBehind = $state(false)
  let showFiles = $state(true)

  const target = $derived(compareTarget.current)
  const refOptions = $derived([
    { value: 'HEAD', label: 'HEAD' },
    ...refs.local.map((branch) => ({ value: branch.name, label: branch.name })),
    ...refs.remote.map((branch) => ({ value: branch.name, label: branch.name })),
    ...refs.tags.map((tag) => ({ value: tag.name, label: `${tag.name} (tag)` }))
  ])
  const headOptions = $derived([{ value: WORKING_TREE, label: 'Working tree' }, ...refOptions])
  const headLabel = $derived.by(() => {
    if (!target || target.head === null) return 'the working tree'
    return target.head
  })

  /** Re-reads the refs the pickers offer. */
  async function loadRefs(): Promise<void> {
    try {
      refs = await window.workbench.git.refs(worktreeId)
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  /** Runs the comparison the section is pointed at. */
  async function compare(): Promise<void> {
    const current = compareTarget.current
    if (!current) {
      result = null
      return
    }
    try {
      result = await window.workbench.git.compare(worktreeId, current.base, current.head)
    } catch (err) {
      result = null
      store.setError((err as Error).message)
    }
  }

  /** The base picker changed. */
  function pickBase(value: string | string[]): void {
    if (typeof value !== 'string') return
    let head: string | null = null
    if (target) head = target.head
    compareRefs(value, head)
  }

  /** The head picker changed; the empty value is the working tree. */
  function pickHead(value: string | string[]): void {
    if (typeof value !== 'string') return
    let base = 'HEAD'
    if (target) base = target.base
    let head: string | null = value
    if (value === WORKING_TREE) head = null
    compareRefs(base, head)
  }

  /** Swaps base and head; the working tree can only be the head, so it stays. */
  function swap(): void {
    if (!target || target.head === null) return
    compareRefs(target.head, target.base)
  }

  /** Opens one differing file as a diff from base to head. */
  function openFile(file: DiffFile): void {
    const current = compareTarget.current
    if (!current) return
    if (current.head === null) {
      void openWorkingTreeDiff({
        worktreeId,
        worktreePath,
        path: file.path,
        oldPath: file.oldPath,
        revision: current.base,
        label: current.base,
        deleted: file.changeType === 'deleted'
      })
      return
    }
    void openRevisionDiff({
      worktreeId,
      path: file.path,
      oldPath: file.oldPath,
      leftRevision: revisionHaving(file, current.base, 'added'),
      rightRevision: revisionHaving(file, current.head, 'deleted'),
      leftLabel: current.base,
      rightLabel: current.head
    })
  }

  /** The revision to read a side from, or null on the side where the file does not exist. */
  function revisionHaving(file: DiffFile, revision: string, absentWhen: string): string | null {
    if (file.changeType === absentWhen) return null
    return revision
  }

  /** The base picker's current value, empty until a base is picked. */
  function baseValue(): string {
    if (!target) return ''
    return target.base
  }

  /** Whether a picker option matches what was typed into its search box. */
  function matchesQuery(option: { label: string }, query: string): boolean {
    return option.label.toLowerCase().includes(query.toLowerCase())
  }

  /** The head picker's current value. */
  function headValue(): string {
    if (!target || target.head === null) return WORKING_TREE
    return target.head
  }

  $effect(() => {
    void worktreeId
    void refreshKey
    void loadRefs()
  })

  $effect(() => {
    void compareTarget.current
    void refreshKey
    void compare()
  })

  // A "compare with" from a branch's menu opens the section and brings it into view.
  $effect(() => {
    if (compareTarget.version === 0) return
    open = true
    sectionElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
</script>

<div bind:this={sectionElement}>
  <GitSection title="Compare" bind:open>
    {#snippet actions()}
      <RowAction
        icon={ArrowsLeftRightIcon}
        title="Swap base and head"
        disabled={!target || target.head === null}
        onclick={swap}
      />
    {/snippet}

    <div class="flex flex-col gap-1 px-2 pt-1 pb-2 text-xs">
      <label class="flex items-center gap-2">
        <span class="w-9 shrink-0 text-2xs text-dim">base</span>
        <div class="min-w-0 flex-1">
          <Select
            value={baseValue()}
            options={refOptions}
            placeholder="Pick a ref"
            filter={matchesQuery}
            onChange={pickBase}
          />
        </div>
      </label>
      <label class="flex items-center gap-2">
        <span class="w-9 shrink-0 text-2xs text-dim">head</span>
        <div class="min-w-0 flex-1">
          <Select
            value={headValue()}
            options={headOptions}
            filter={matchesQuery}
            onChange={pickHead}
          />
        </div>
      </label>
    </div>

    {#if target && result}
      <div role="tree">
        <button
          class="flex w-full items-center gap-1 py-[3px] pr-2 pl-1 text-left text-2xs text-muted hover:bg-hover"
          onclick={() => (showAhead = !showAhead)}
        >
          <span class="w-3 shrink-0 text-center text-dim">{showAhead ? '▾' : '▸'}</span>
          <span class="truncate">{result.ahead.length} in {headLabel}, not in {target.base}</span>
        </button>
        {#if showAhead}
          {#each result.ahead as commit (commit.sha)}
            <CommitRow {worktreeId} {commit} direction="outgoing" />
          {/each}
        {/if}

        <button
          class="flex w-full items-center gap-1 py-[3px] pr-2 pl-1 text-left text-2xs text-muted hover:bg-hover"
          onclick={() => (showBehind = !showBehind)}
        >
          <span class="w-3 shrink-0 text-center text-dim">{showBehind ? '▾' : '▸'}</span>
          <span class="truncate">{result.behind.length} in {target.base}, not in {headLabel}</span>
        </button>
        {#if showBehind}
          {#each result.behind as commit (commit.sha)}
            <CommitRow {worktreeId} {commit} direction="incoming" />
          {/each}
        {/if}

        <button
          class="flex w-full items-center gap-1 py-[3px] pr-2 pl-1 text-left text-2xs text-muted hover:bg-hover"
          onclick={() => (showFiles = !showFiles)}
        >
          <span class="w-3 shrink-0 text-center text-dim">{showFiles ? '▾' : '▸'}</span>
          <span class="truncate">{result.files.length} files differ</span>
        </button>
        {#if showFiles}
          {#each result.files as file (file.path)}
            <CommitFileRow {file} depth={1} onOpen={openFile} />
          {/each}
        {/if}
      </div>
    {:else if !target}
      <p class="px-3 pb-2 text-2xs text-dim">
        Pick a base, or use “Compare with…” on a branch or tag.
      </p>
    {/if}
  </GitSection>
</div>
