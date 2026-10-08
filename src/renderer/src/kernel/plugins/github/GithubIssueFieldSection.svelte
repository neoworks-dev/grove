<script lang="ts">
  // One of the organisation's single-select issue fields in the thread's
  // sidebar, Priority or Effort say: its value, and a menu to change it.
  import GithubMenu from './GithubMenu.svelte'
  import { optionColour } from './board'
  import { applyIssueField, github } from './store.svelte'
  import type { GithubIssueField } from '../../../../../shared/types'

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

<section class="flex flex-col gap-1.5">
  <div class="flex items-center justify-between">
    <h3 class="font-medium text-default">{field.name}</h3>
    <GithubMenu label="Edit" align="right" disabled={github.busy}>
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
              <span
                class="size-2 shrink-0 rounded-full"
                style:background={optionColour(option.color)}
              ></span>
              <span class="truncate">{option.name}</span>
            </button>
          {/each}
        </div>
      {/snippet}
    </GithubMenu>
  </div>
  {#if current}
    <p class="flex items-center gap-1.5 text-default">
      <span class="size-2 shrink-0 rounded-full" style:background={optionColour(current.color)}
      ></span>
      {current.name}
    </p>
  {:else}
    <p class="text-dim">None yet</p>
  {/if}
</section>
