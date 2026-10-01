<script lang="ts">
  // Every file the session has edited, over the conversation, so what the agent
  // has been doing can be read without scrolling back through its tool calls.
  //
  // Picking one opens it in the editor beside the file as it would be without
  // the session's edits. That side is rebuilt from the file on disk by undoing
  // only this session's edits, so what the user changed alongside is on both
  // sides and stays out of the diff.
  import Icon from '@iconify/svelte'
  import PencilSimple from 'phosphor-svelte/lib/PencilSimple'
  import { fileIcon } from '../../../../lib/icons'
  import { linesOf, openWorkingTreeAgainst } from '../../../../lib/nvim/revisionDiff'
  import { store } from '../../../../lib/store.svelte'
  import type { EditedFile } from '../../../../lib/agents/types'

  let {
    sessionId,
    worktreeId,
    worktreePath,
    revision,
    onClose
  }: {
    sessionId: string
    worktreeId: string
    worktreePath: string
    /** The session's last event; a new one may have edited something. */
    revision: number
    onClose: () => void
  } = $props()

  let files = $state<EditedFile[] | null>(null)
  let failure = $state('')
  let panel = $state<HTMLDivElement>()
  let request = 0

  $effect(() => {
    void load(sessionId, revision)
  })

  /** Reads the list again; an answer overtaken by a newer request is dropped. */
  async function load(id: string, _revision: number): Promise<void> {
    request += 1
    const mine = request
    try {
      const edited = await window.workbench.agents.editedFiles(id)
      if (mine !== request) return
      files = edited
      failure = ''
    } catch (error) {
      if (mine !== request) return
      failure = (error as Error).message
    }
  }

  /** Opens one file beside what it was before the session's edits. */
  async function open(file: EditedFile): Promise<void> {
    try {
      const base = await window.workbench.agents.editedFileBase(sessionId, file.path)
      await openWorkingTreeAgainst({
        worktreeId,
        worktreePath,
        path: file.path,
        leftLines: linesOf(base),
        label: 'before session'
      })
      onClose()
    } catch (error) {
      store.setError((error as Error).message)
    }
  }

  /** Closes on a press anywhere outside the panel. */
  function onWindowPointerDown(event: PointerEvent): void {
    if (!panel) return
    if (panel.contains(event.target as Node)) return
    onClose()
  }

  function onWindowKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    onClose()
  }

  /** The folder part of a path, shown dimmed after its name. */
  function folderOf(path: string): string {
    const slash = path.lastIndexOf('/')
    if (slash < 0) return ''
    return path.slice(0, slash)
  }

  /** The last segment of a path. */
  function nameOf(path: string): string {
    const slash = path.lastIndexOf('/')
    if (slash < 0) return path
    return path.slice(slash + 1)
  }

  /** How many files, in words. */
  function countLabel(count: number): string {
    if (count === 1) return '1 file'
    return `${count} files`
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeyDown} />

<div
  bind:this={panel}
  class="absolute right-1.5 top-8 z-30 flex max-h-[60%] w-80 max-w-[calc(100%-0.75rem)] flex-col overflow-hidden rounded-md border border-line bg-elevated shadow-lg"
  role="dialog"
  aria-label="Files this session edited"
  data-testid="agent-edited-files"
>
  <div class="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1.5 text-2xs">
    <PencilSimple size={12} class="shrink-0 text-blue" />
    <span class="min-w-0 flex-1 truncate font-medium text-default">Edited this session</span>
    {#if files}
      <span class="shrink-0 text-dim">{countLabel(files.length)}</span>
    {/if}
  </div>
  {#if failure}
    <p class="px-2.5 py-2 text-2xs text-red">{failure}</p>
  {:else if files === null}
    <p class="px-2.5 py-2 text-2xs text-dim">Reading the session…</p>
  {:else if files.length === 0}
    <p class="px-2.5 py-2 text-2xs text-dim">The session has not edited any files yet.</p>
  {:else}
    <ul class="min-h-0 overflow-y-auto">
      {#each files as file (file.path)}
        <li>
          <button
            class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left font-mono text-2xs transition-colors duration-100 hover:bg-hover"
            title="Show what the session changed in {file.path}"
            onclick={() => void open(file)}
          >
            <Icon icon={fileIcon(file.path)} width="12" height="12" class="shrink-0" />
            <span class="shrink-0 text-default">{nameOf(file.path)}</span>
            <span class="min-w-0 flex-1 truncate text-dim">{folderOf(file.path)}</span>
            {#if file.created}
              <span class="shrink-0 font-sans text-dim">new</span>
            {/if}
            <span class="shrink-0 text-green">+{file.added}</span>
            <span class="shrink-0 text-red">−{file.removed}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
