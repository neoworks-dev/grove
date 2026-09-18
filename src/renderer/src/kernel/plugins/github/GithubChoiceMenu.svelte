<script lang="ts">
  // A filter menu over plain names: milestone titles, issue types, project
  // boards. The Author and Labels menus draw avatars and pills and stay
  // hand-written; these three are the same list of names three times over.
  import Checkbox from '@neoworks-dev/ui/Checkbox'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import GithubMenu from './GithubMenu.svelte'

  let {
    label,
    options,
    selected,
    empty,
    ontoggle
  }: {
    label: string
    options: string[]
    selected: string[]
    /** What to say when there is nothing here to pick from. */
    empty: string
    ontoggle: (value: string) => void
  } = $props()
</script>

<GithubMenu {label} count={selected.length}>
  <FloatingScrollbar class="max-h-56">
    <div class="flex flex-col">
      {#each options as option (option)}
        <button
          class="flex items-center gap-2 rounded px-1.5 py-1 text-left text-2xs text-default hover:bg-hover"
          onclick={() => ontoggle(option)}
        >
          <Checkbox size="sm" checked={selected.includes(option)} />
          <span class="truncate">{option}</span>
        </button>
      {/each}
      {#if options.length === 0}
        <p class="px-1.5 py-1 text-2xs text-dim">{empty}</p>
      {/if}
    </div>
  </FloatingScrollbar>
</GithubMenu>
