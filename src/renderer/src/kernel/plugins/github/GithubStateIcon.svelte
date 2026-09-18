<script lang="ts">
  // An item's state as GitHub draws it in a list: an open circle, a check for
  // something finished, a merge glyph, a dash for a draft. The colour carries
  // the same meaning as the word, so the row does not have to spend space on
  // spelling it out.
  import CircleDashedIcon from 'phosphor-svelte/lib/CircleDashedIcon'
  import GitMergeIcon from 'phosphor-svelte/lib/GitMergeIcon'
  import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon'
  import CircleIcon from 'phosphor-svelte/lib/CircleIcon'
  import { stateTone } from './filter'
  import type { GithubItemKind } from '../../../../../shared/types'

  // Structural rather than a whole GithubItem: a sub-issue in the rail is a
  // number, a title and a state, and that is all this needs to draw one.
  let {
    item,
    size = 13
  }: {
    item: { kind: GithubItemKind; state: string; isDraft?: boolean }
    size?: number
  } = $props()

  const tone = $derived(stateTone(item))
  const label = $derived.by<string>(() => {
    if (item.kind === 'pull' && item.isDraft) return 'draft'
    return item.state.toLowerCase()
  })
</script>

<span
  class="flex items-center"
  class:text-green={tone === 'green'}
  class:text-red={tone === 'red'}
  class:text-violet={tone === 'violet'}
  class:text-dim={tone === 'dim'}
  title={label}
  aria-label={label}
>
  {#if item.kind === 'pull' && item.isDraft}
    <CircleDashedIcon {size} />
  {:else if item.state === 'MERGED'}
    <GitMergeIcon {size} />
  {:else if item.state === 'CLOSED'}
    <CheckCircleIcon {size} />
  {:else}
    <CircleIcon {size} />
  {/if}
</span>
