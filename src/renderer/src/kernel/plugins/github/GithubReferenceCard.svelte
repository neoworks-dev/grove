<script lang="ts">
  // An issue or pull request an agent's message names, drawn as a card under
  // the message: its state and title, its labels, and who is involved. Clicking
  // it opens the thread in the GitHub pane.
  //
  // A reference that does not resolve — another repository, a number GitHub
  // has nothing for, no `gh` — draws nothing: the text still says `#212`, and a
  // card that only says "not found" would be noise under every such message.
  import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircleIcon'
  import GithubAvatar from './GithubAvatar.svelte'
  import GithubBadge from './GithubBadge.svelte'
  import GithubLabelPill from './GithubLabelPill.svelte'
  import GithubStateIcon from './GithubStateIcon.svelte'
  import { relativeTime, reviewLabel, reviewTone } from './filter'
  import { parseReference } from './references'
  import { fetchItemByNumber, openItemByNumber, openRepoName } from './store.svelte'
  import { layout } from '../../../lib/layout.svelte'
  import type { GithubActor, GithubItemDetail } from '../../../../../shared/types'

  let { reference }: { reference: string } = $props()

  const MAX_PARTICIPANTS = 6
  const MAX_LABELS = 4

  let detail = $state<GithubItemDetail | null>(null)
  let loading = $state(true)

  $effect(() => {
    const target = parseReference(reference)
    let cancelled = false
    loading = true
    detail = null
    void resolve(target).then((resolved) => {
      if (cancelled) return
      detail = resolved
      loading = false
    })
    return () => {
      cancelled = true
    }
  })

  /** The item, or null when the reference is not one of this repository's. */
  async function resolve(target: {
    repo: string | null
    number: number
  }): Promise<GithubItemDetail | null> {
    try {
      if (target.repo !== null) {
        const open = await openRepoName()
        if (!open || open.toLowerCase() !== target.repo.toLowerCase()) return null
      }
      return await fetchItemByNumber(target.number)
    } catch {
      return null
    }
  }

  /** Everyone who opened it, is assigned to it or took part in its thread. */
  function participantsOf(item: GithubItemDetail): GithubActor[] {
    const people = new Map<string, GithubActor>()
    people.set(item.authorActor.login, item.authorActor)
    for (const entry of item.timeline) {
      let actor: GithubActor
      if (entry.type === 'comment') actor = entry.comment.author
      else actor = entry.event.actor
      if (!people.has(actor.login)) people.set(actor.login, actor)
    }
    for (const login of item.assignees) {
      if (!people.has(login)) people.set(login, { login, avatarUrl: null })
    }
    return [...people.values()]
  }

  const participants = $derived(detail ? participantsOf(detail) : [])
  const comments = $derived(
    detail ? detail.timeline.filter((entry) => entry.type === 'comment').length : 0
  )
  const review = $derived(detail?.kind === 'pull' ? reviewLabel(detail.reviewDecision) : null)

  /** Show the thread in the GitHub pane. */
  function open(): void {
    if (!detail) return
    layout.ensurePane('github')
    void openItemByNumber(detail.number)
  }
</script>

{#if loading}
  <div
    class="mt-1.5 flex items-center gap-2 rounded-md border border-line bg-elevated px-2.5 py-2 text-2xs text-dim"
  >
    <span class="font-mono">#{parseReference(reference).number}</span>
    <span class="h-2 w-32 animate-pulse rounded bg-hover"></span>
  </div>
{:else if detail}
  <button
    class="mt-1.5 flex w-full flex-col gap-1 rounded-md border border-line bg-elevated px-2.5 py-2 text-left transition-colors duration-100 hover:border-line-strong hover:bg-hover"
    title="Open #{detail.number} in the GitHub pane"
    onclick={open}
  >
    <span class="flex items-start gap-1.5">
      <span class="mt-px shrink-0">
        <GithubStateIcon item={detail} />
      </span>
      <span class="min-w-0 flex-1 text-xs font-medium text-default">
        {detail.title}
        <span class="font-mono font-normal text-dim">#{detail.number}</span>
      </span>
    </span>

    {#if detail.labels.length > 0}
      <span class="flex flex-wrap gap-1 pl-5">
        {#each detail.labels.slice(0, MAX_LABELS) as label (label.name)}
          <GithubLabelPill {label} />
        {/each}
        {#if detail.labels.length > MAX_LABELS}
          <span class="text-2xs text-dim">+{detail.labels.length - MAX_LABELS}</span>
        {/if}
      </span>
    {/if}

    <span class="flex items-center gap-2 pl-5 text-2xs text-dim">
      <span class="flex items-center -space-x-1">
        {#each participants.slice(0, MAX_PARTICIPANTS) as person (person.login)}
          <span class="rounded-full ring-1 ring-elevated" title={person.login}>
            <GithubAvatar actor={person} size={14} />
          </span>
        {/each}
      </span>
      {#if participants.length > MAX_PARTICIPANTS}
        <span>+{participants.length - MAX_PARTICIPANTS}</span>
      {/if}
      <span class="min-w-0 truncate">
        {detail.authorActor.login} · updated {relativeTime(detail.updatedAt)} ago
      </span>
      <span class="flex-1"></span>
      {#if detail.kind === 'pull'}
        {#if detail.isDraft}
          <GithubBadge tone="dim">draft</GithubBadge>
        {/if}
        {#if review}
          <GithubBadge tone={reviewTone(detail.reviewDecision)}>{review}</GithubBadge>
        {/if}
        {#if detail.additions !== undefined}
          <span class="shrink-0 font-mono">
            <span class="text-green">+{detail.additions}</span>
            <span class="text-red">−{detail.deletions}</span>
          </span>
        {/if}
      {/if}
      {#if comments > 0}
        <span class="flex shrink-0 items-center gap-0.5" title="{comments} comments">
          <ChatCircleIcon size={11} />
          {comments}
        </span>
      {/if}
    </span>
  </button>
{/if}
