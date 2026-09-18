<script lang="ts">
  // A textarea that completes @mentions. The suggestion list sits under the box
  // rather than at the caret: a textarea gives no caret coordinates without
  // mirroring its whole content into a hidden element, and the list is short
  // enough that anchoring it to the field costs nothing in practice.
  import GithubAvatar from './GithubAvatar.svelte'
  import { github, loadMentionables } from './store.svelte'
  import { activeMention, applyMention, rankMentions, type MentionQuery } from './mentions'
  import { applyMarkdownEdit, type MarkdownEdit } from './markdownEdits'
  import { renderMarkdown } from '../../../lib/markdown'
  import TextHOneIcon from 'phosphor-svelte/lib/TextHOneIcon'
  import TextBIcon from 'phosphor-svelte/lib/TextBIcon'
  import TextItalicIcon from 'phosphor-svelte/lib/TextItalicIcon'
  import QuotesIcon from 'phosphor-svelte/lib/QuotesIcon'
  import CodeIcon from 'phosphor-svelte/lib/CodeIcon'
  import LinkSimpleIcon from 'phosphor-svelte/lib/LinkSimpleIcon'
  import ListBulletsIcon from 'phosphor-svelte/lib/ListBulletsIcon'
  import ListNumbersIcon from 'phosphor-svelte/lib/ListNumbersIcon'
  import ListChecksIcon from 'phosphor-svelte/lib/ListChecksIcon'
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
    /** Hides the Write/Preview tabs and the toolbar for a one-line box. */
    chrome?: boolean
  } = $props()

  const MAX_SUGGESTIONS = 6

  let field = $state<HTMLTextAreaElement | null>(null)
  let previewing = $state(false)

  // Formatting buttons, in GitHub's order. Each is a pure edit over the text
  // and selection, so what they do is decided in markdownEdits.ts.
  const TOOLS: { edit: MarkdownEdit; label: string }[] = [
    { edit: 'heading', label: 'Heading' },
    { edit: 'bold', label: 'Bold' },
    { edit: 'italic', label: 'Italic' },
    { edit: 'quote', label: 'Quote' },
    { edit: 'code', label: 'Code' },
    { edit: 'link', label: 'Link' },
    { edit: 'bullets', label: 'Bulleted list' },
    { edit: 'numbers', label: 'Numbered list' },
    { edit: 'tasks', label: 'Task list' }
  ]

  /** Run a formatting button against the live selection, then restore it. */
  function format(edit: MarkdownEdit): void {
    if (!field) return
    const result = applyMarkdownEdit(value, field.selectionStart, field.selectionEnd, edit)
    value = result.text
    const target = field
    requestAnimationFrame(() => {
      target.focus()
      target.setSelectionRange(result.selectionStart, result.selectionEnd)
    })
  }
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
  {#if chrome}
    <!-- Write / Preview, then the formatting row — GitHub's layout, because the
         muscle memory for it is the point of matching it. -->
    <div class="flex items-center gap-0.5 rounded-t-md border border-b-0 border-line px-1 py-0.5">
      <button
        class="rounded px-1.5 py-0.5 text-2xs hover:bg-hover"
        class:text-default={!previewing}
        class:text-dim={previewing}
        onclick={() => (previewing = false)}
      >
        Write
      </button>
      <button
        class="rounded px-1.5 py-0.5 text-2xs hover:bg-hover"
        class:text-default={previewing}
        class:text-dim={!previewing}
        onclick={() => (previewing = true)}
      >
        Preview
      </button>

      {#if !previewing}
        <span class="mx-1 h-3 w-px bg-line"></span>
        {#each TOOLS as tool (tool.edit)}
          <button
            class="rounded p-1 text-dim hover:bg-hover hover:text-default"
            title={tool.label}
            aria-label={tool.label}
            {disabled}
            onclick={() => format(tool.edit)}
          >
            {#if tool.edit === 'heading'}
              <TextHOneIcon size={12} />
            {:else if tool.edit === 'bold'}
              <TextBIcon size={12} />
            {:else if tool.edit === 'italic'}
              <TextItalicIcon size={12} />
            {:else if tool.edit === 'quote'}
              <QuotesIcon size={12} />
            {:else if tool.edit === 'code'}
              <CodeIcon size={12} />
            {:else if tool.edit === 'link'}
              <LinkSimpleIcon size={12} />
            {:else if tool.edit === 'bullets'}
              <ListBulletsIcon size={12} />
            {:else if tool.edit === 'numbers'}
              <ListNumbersIcon size={12} />
            {:else}
              <ListChecksIcon size={12} />
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  {/if}

  {#if previewing && chrome}
    <div
      class="agent-markdown prose max-w-none overflow-auto rounded-b-md border border-line bg-input px-2 py-1.5 text-xs text-default"
      style:min-height="{rows * 1.5}rem"
    >
      {#if value.trim().length > 0}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html renderMarkdown(value)}
      {:else}
        <p class="text-dim">Nothing to preview.</p>
      {/if}
    </div>
  {:else}
    <textarea
      bind:this={field}
      bind:value
      class="w-full resize-none border border-line bg-input px-2 py-1.5 text-xs text-default outline-none placeholder:text-dim focus:border-line-strong"
      class:rounded-md={!chrome}
      class:rounded-b-md={chrome}
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
  {/if}

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
