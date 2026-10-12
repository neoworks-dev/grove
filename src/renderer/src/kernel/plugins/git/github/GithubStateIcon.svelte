<script lang="ts">
  // An item's kind and state as GitHub draws them in a list: a pull request
  // glyph for a pull request, a merge glyph once it is merged, and a circle for
  // an issue, with a check once it is closed. A draft is the pull request glyph
  // in grey. The colour carries the state, so the row does not have to spend
  // space on spelling either out.
  import GitMergeIcon from 'phosphor-svelte/lib/GitMergeIcon'
  import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon'
  import CircleIcon from 'phosphor-svelte/lib/CircleIcon'
  import GitPullRequestIcon from 'phosphor-svelte/lib/GitPullRequestIcon'
  import { stateTone } from './filter'
  import type { GithubItemKind } from '../../../../../../shared/types'

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
    let kind = 'issue'
    if (item.kind === 'pull') kind = 'pull request'
    if (item.kind === 'pull' && item.isDraft) return `draft ${kind}`
    return `${item.state.toLowerCase()} ${kind}`
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
  {#if item.kind === 'pull' && item.state === 'MERGED'}
    <GitMergeIcon {size} />
  {:else if item.kind === 'pull'}
    <GitPullRequestIcon {size} />
  {:else if item.state === 'CLOSED'}
    <CheckCircleIcon {size} />
  {:else}
    <CircleIcon {size} />
  {/if}
</span>
