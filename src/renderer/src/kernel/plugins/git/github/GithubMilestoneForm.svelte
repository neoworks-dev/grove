<script lang="ts">
  // A new milestone, written in the thread's sidebar: a title, what it is for
  // and when it is due. Creating it also puts the open item on it, the way
  // GitHub's own picker does.
  import { createMilestoneAndApply, github } from './store.svelte'

  let { onclose }: { onclose: () => void } = $props()

  let title = $state('')
  let description = $state('')
  /** `YYYY-MM-DD` from the date input, or empty for no due date. */
  let dueOn = $state('')

  const canCreate = $derived(title.trim().length > 0 && !github.busy)

  /** Creates the milestone, puts the item on it, and closes the form. */
  async function create(): Promise<void> {
    if (!canCreate) return
    let due: string | null = null
    if (dueOn.length > 0) due = dueOn
    await createMilestoneAndApply({ title, description, dueOn: due })
    onclose()
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onclose()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void create()
    }
  }

  /** Focuses the title as soon as the form appears. */
  function focusOnMount(element: HTMLInputElement): void {
    element.focus()
  }
</script>

<!-- Escape and Ctrl+Enter are read on each field rather than on the form, which
     is not itself something that takes keys. -->
<div class="flex flex-col gap-1.5" aria-label="New milestone">
  <input
    class="w-full rounded-md border border-line bg-input px-1.5 py-1 text-2xs text-default outline-none placeholder:text-dim focus:border-line-strong"
    placeholder="Title"
    bind:value={title}
    onkeydown={onKey}
    use:focusOnMount
  />
  <textarea
    class="w-full resize-none rounded-md border border-line bg-input px-1.5 py-1 text-2xs text-default outline-none placeholder:text-dim focus:border-line-strong"
    rows="3"
    placeholder="Description (optional)"
    bind:value={description}
    onkeydown={onKey}
  ></textarea>
  <label class="flex items-center gap-1.5 text-dim">
    Due
    <input
      type="date"
      class="min-w-0 flex-1 rounded-md border border-line bg-input px-1.5 py-0.5 text-2xs text-default outline-none focus:border-line-strong"
      bind:value={dueOn}
      onkeydown={onKey}
    />
  </label>
  <div class="flex justify-end gap-1.5">
    <button
      class="cursor-pointer rounded-md px-2 py-0.5 text-2xs text-dim hover:bg-hover hover:text-default"
      onclick={onclose}
    >
      Cancel
    </button>
    <button
      class="cursor-pointer rounded-md bg-action px-2 py-0.5 text-2xs text-action-fg hover:opacity-90 disabled:cursor-default disabled:opacity-50"
      disabled={!canCreate}
      onclick={create}
    >
      {#if github.busy}
        Creating…
      {:else}
        Create
      {/if}
    </button>
  </div>
</div>
