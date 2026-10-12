<script lang="ts">
  // One of the organisation's single-select issue fields in the thread's
  // sidebar, Priority or Effort say: a row whose value opens a menu to change it.
  import GithubMenu from './GithubMenu.svelte'
  import GithubPropertyRow from './GithubPropertyRow.svelte'
  import { optionColour } from './board'
  import { applyIssueField, github } from './store.svelte'
  import type { GithubIssueField } from '../../../../../../shared/types'

  let {
    field,
    optionId
  }: {
    field: GithubIssueField
    /** The issue's option for this field, or null when it is not set. */
    optionId: string | null
  } = $props()

  const current = $derived(field.options.find((option) => option.id === optionId))
</script>

<GithubPropertyRow name={field.name}>
  <GithubMenu label="Change {field.name.toLowerCase()}" disabled={github.busy}>
    {#snippet trigger()}
      {#if current}
        <span class="size-2 shrink-0 rounded-full" style:background={optionColour(current.color)}
        ></span>
        <span class="truncate text-default">{current.name}</span>
      {:else}
        <span class="text-faint">—</span>
      {/if}
    {/snippet}
    {#snippet children(close)}
      <div class="flex flex-col">
        <button
          class="rounded px-1.5 py-1 text-left text-2xs text-dim hover:bg-hover"
          onclick={() => {
            close()
            void applyIssueField(field.id, null)
          }}
        >
          No {field.name.toLowerCase()}
        </button>
        {#each field.options as option (option.id)}
          <button
            class="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-2xs hover:bg-hover"
            class:text-default={option.id === optionId}
            class:text-dim={option.id !== optionId}
            onclick={() => {
              close()
              void applyIssueField(field.id, option.id)
            }}
          >
            <span class="size-2 shrink-0 rounded-full" style:background={optionColour(option.color)}
            ></span>
            <span class="truncate">{option.name}</span>
          </button>
        {/each}
      </div>
    {/snippet}
  </GithubMenu>
</GithubPropertyRow>
