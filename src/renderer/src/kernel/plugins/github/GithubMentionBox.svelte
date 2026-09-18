<script lang="ts">
  // A textarea that completes @mentions. The suggestion list sits under the box
  // rather than at the caret: a textarea gives no caret coordinates without
  // mirroring its whole content into a hidden element, and the list is short
  // enough that anchoring it to the field costs nothing in practice.
  import GithubAvatar from './GithubAvatar.svelte'
  import { github, loadMentionables } from './store.svelte'
  import { activeMention, applyMention, rankMentions, type MentionQuery } from './mentions'
  import type { GithubActor } from '../../../../../shared/types'

  let {
    value = $bindable(''),
    placeholder = '',
    rows = 4,
    disabled = false,
    onsubmit
  }: {
    value?: string
    placeholder?: string
    rows?: number
    disabled?: boolean
    /** Cmd/Ctrl+Enter, when the suggestion list is not taking the key. */
    onsubmit?: () => void
    onfocus?: () => void
    onblur?: () => void
  } = $props()

  const MAX_SUGGESTIONS = 6

  let field = $state<HTMLTextAreaElement | null>(null)
  let mention = $state<MentionQuery | null>(null)
  let highlighted = $state(0)

  $effect(() => {
    void loadMentionables()
  })

  // Everyone who could be meant: the repository's assignable people plus the
  // logins already on this thread, which covers outside contributors.
  const candidates = $derived.by<GithubActor[]>(() => {
    const collected: GithubActor[] = []
    for (const actor of [...github.threadActors, ...github.mentionables]) {
      if (collected.some((known) => known.login === actor.login)) continue
      collected.push(actor)
    }
    return collected
  })

  const suggestions = $derived.by<GithubActor[]>(() => {
    if (!mention) return []
    const logins = rankMentions(
      candidates.map((actor) => actor.login),
      mention.query,
      MAX_SUGGESTIONS
    )
    return logins.map((login) => candidates.find((actor) => actor.login === login) as GithubActor)
  })

  const open = $derived(mention !== null && suggestions.length > 0)

  /** Re-read where the caret is after anything that could have moved it. */
  function syncMention(): void {
    if (!field) return
    const next = activeMention(value, field.selectionStart)
    mention = next
    highlighted = 0
  }

  function accept(login: string): void {
    if (!mention || !field) return
    const result = applyMention(value, mention, login)
    value = result.text
    mention = null
    // The caret has to be placed after Svelte has written the new value back.
    const target = field
    requestAnimationFrame(() => {
      target.focus()
      target.setSelectionRange(result.caret, result.caret)
    })
  }

  function onKeydown(event: KeyboardEvent): void {
    if (open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        highlighted = (highlighted + 1) % suggestions.length
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        highlighted = (highlighted - 1 + suggestions.length) % suggestions.length
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        accept(suggestions[highlighted].login)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        mention = null
        return
      }
    }
    if (event.key !== 'Enter') return
    if (!event.metaKey && !event.ctrlKey) return
    if (!onsubmit) return
    event.preventDefault()
    onsubmit()
  }
</script>

<div class="relative">
  <textarea
    bind:this={field}
    bind:value
    class="w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs text-default outline-none placeholder:text-dim focus:border-line-strong"
    {placeholder}
    {rows}
    {disabled}
    oninput={syncMention}
    onkeyup={syncMention}
    onclick={syncMention}
    onkeydown={onKeydown}
    onfocus={() => onfocus?.()}
    onblur={() => {
      mention = null
      onblur?.()
    }}
  ></textarea>

  {#if open}
    <ul
      class="absolute bottom-full left-0 z-10 mb-1 w-56 overflow-hidden rounded-md border border-line bg-raised shadow-lg"
      role="listbox"
    >
      {#each suggestions as actor, index (actor.login)}
        <li>
          <button
            class="flex w-full items-center gap-2 px-2 py-1 text-left text-2xs text-default hover:bg-hover"
            class:bg-hover={index === highlighted}
            role="option"
            aria-selected={index === highlighted}
            onmousedown={(event) => {
              // mousedown, not click: blur would close the list first.
              event.preventDefault()
              accept(actor.login)
            }}
          >
            <GithubAvatar {actor} size={16} />
            <span class="truncate">{actor.login}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
