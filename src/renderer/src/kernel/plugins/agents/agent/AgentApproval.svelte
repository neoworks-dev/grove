<script lang="ts">
  // A tool call the agent is blocked on.
  //
  // The harness parks its loop until this is answered, so the card replaces the
  // composer rather than sitting beside it — there is nothing else worth doing
  // until it is dealt with. The choices are a numbered list: Tab and the arrow
  // keys move, a digit jumps straight to one, and Enter confirms, because
  // answering these is the most repeated action in the pane.

  import Icon from '@iconify/svelte'
  import Info from 'phosphor-svelte/lib/Info'
  import PencilSimple from 'phosphor-svelte/lib/PencilSimple'
  import CodeBlock from '../../../../components/CodeBlock.svelte'
  import { fileIcon } from '../../../../lib/icons'
  import { formatShellCommand } from '../../../../lib/shellSyntax.svelte'
  import { diffLines, statsOf } from '../../../../lib/agents/diff'
  import SpawnTargetPicker from './SpawnTargetPicker.svelte'
  import {
    asRecord,
    descriptionOf,
    displayOfCall,
    inputViewOf,
    labelFor,
    messageOf,
    stringOf
  } from '../../../../lib/agents/tools'
  import { choiceOf, spawnInputFor, type SpawnChoice } from '../../../../lib/agents/spawnChoice'
  import type { ToolItem } from '../../../../lib/agents/transcript'
  import type { ConfirmationResult, ToolInfo } from '../../../../lib/agents/types'
  import type { ReviewBatch } from '../../../../../../shared/types'

  let {
    item,
    tool,
    batch,
    onDecide,
    onShowChange,
    onRequestKey,
    onAddEndpoint
  }: {
    item: ToolItem
    tool: ToolInfo | undefined
    // The gated review staged for this call, when the write is being held as a
    // diff in the editor. Its files are what the call is about to change.
    batch: ReviewBatch | null
    /** `input` replaces the call's own when the user changed what it runs with. */
    onDecide: (result: ConfirmationResult, reason?: string, input?: unknown) => void
    onShowChange: () => void
    /** Ask for the key a model route needs, from a spawn's model picker. */
    onRequestKey: (request: { provider: string; variables: string[] }) => void
    onAddEndpoint: () => void
  } = $props()

  // What a spawn will run on, as the user leaves it; the card is keyed per
  // request, so this starts from the call each time.
  // svelte-ignore state_referenced_locally
  let spawnChoice = $state<SpawnChoice | null>(item.spawn ? choiceOf(item.spawn) : null)

  /** The input to allow the call with: the user's runtime, model and effort, when changed. */
  function allowedInput(): unknown {
    if (!item.spawn || !spawnChoice) return undefined
    return spawnInputFor(item.input, item.spawn, spawnChoice)
  }

  let denyReasonMode = $state(false)
  let denyReason = $state('')
  let index = $state(0)
  let rootEl = $state<HTMLDivElement>()
  let reasonEl = $state<HTMLTextAreaElement>()

  // How the call is drawn, as its row in the transcript draws it: a harness's
  // own shell tool describes no display, and is a command by its kind.
  const display = $derived.by(() => {
    if (!tool) return displayOfCall([], item)
    return displayOfCall([tool], item)
  })
  const label = $derived(labelFor(display, item.input))
  // What the call does, in words, when its tool says: "Start agent" over `spawn_agent`.
  const title = $derived(display?.title || item.name)

  // A call that says what it is doing says it here; the arguments stay below it,
  // because "run the formatter" is what the decision is actually about.
  const description = $derived(descriptionOf(item.input))
  const detail = $derived.by(() => {
    if (description.length === 0 || label !== description) {
      return label
    }
    const fields = asRecord(item.input)
    if (fields === null) {
      return ''
    }
    return stringOf(fields.command)
  })
  // A command about to run, laid out as shell whatever its length, so each step
  // being agreed to is on a line of its own.
  const command = $derived.by(() => {
    if (inputViewOf(display) !== 'command') {
      return ''
    }
    const fields = asRecord(item.input)
    if (fields === null) {
      return ''
    }
    return formatShellCommand(stringOf(fields.command), 0)
  })

  const reason = $derived(tool?.summary || tool?.description || 'This tool needs your approval')

  // Only a tool that asked to be rendered as a message gets the message card;
  // everything else keeps the argument dump it had.
  const message = $derived.by(() => {
    if (display?.input !== 'message') return null
    const parsed = messageOf(item.input)
    if (parsed.text.length === 0) return null
    return parsed
  })

  /** The file the call would change, with what it adds and removes. */
  const change = $derived.by(() => {
    const file = batch?.files[0]
    if (!file) return null
    const stats = statsOf(diffLines(file.baseline, file.current))
    return { relPath: file.relPath, added: stats.added, removed: stats.removed }
  })

  const fileName = $derived(change ? change.relPath.split('/').pop() || change.relPath : '')

  interface Choice {
    label: string
    detail: string
    run: () => void
    /** Typing while this choice is selected starts the reason, as in Claude Code. */
    takesText?: boolean
  }

  const choices = $derived.by<Choice[]>(() => {
    const list: Choice[] = [
      {
        label: 'Allow',
        detail: 'Allow only this time',
        run: () => onDecide('allow', undefined, allowedInput())
      },
      {
        label: 'Always allow in this session',
        detail: `Do not ask again for ${title}`,
        run: () => onDecide('always_session', undefined, allowedInput())
      }
    ]
    if (batch) {
      list.push({
        label: 'Show the diff',
        detail: 'Open the proposed change in the editor',
        run: onShowChange
      })
    }
    list.push({ label: 'Deny', detail: 'Reject it for now', run: () => onDecide('deny') })
    list.push({
      label: 'Deny with reason',
      detail: 'Say why, so the agent can try something else',
      run: () => (denyReasonMode = true),
      takesText: true
    })
    return list
  })

  // Focus the card so the keys below reach it, and the reason box once it is
  // open, so the reason can be typed without reaching for the mouse.
  $effect(() => {
    if (denyReasonMode) {
      queueMicrotask(() => reasonEl?.focus())
      return
    }
    queueMicrotask(() => rootEl?.focus())
  })

  /** Gives the card the keyboard again, on the reason box when that is open. */
  export function focus(): void {
    if (denyReasonMode) {
      reasonEl?.focus()
      return
    }
    rootEl?.focus()
  }

  /** A key that types a character, rather than moving, confirming or chording. */
  function isTyping(event: KeyboardEvent): boolean {
    return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
  }

  /**
   * Enter sends the reason and Escape goes back to the choices; Tab moves on
   * through them, keeping what was typed. Shift+Enter is a new line.
   */
  function onReasonKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      denyReasonMode = false
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      denyReasonMode = false
      move(event.shiftKey ? -1 : 1)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onDecide('deny', denyReason)
    }
  }

  function move(step: number): void {
    const count = choices.length
    if (count === 0) return
    index = (index + step + count) % count
  }

  function onKey(event: KeyboardEvent): void {
    if (denyReasonMode) return
    // Tabbing onto the reason opens its box, so it can be typed straight away.
    if (event.key === 'Tab') {
      event.preventDefault()
      move(event.shiftKey ? -1 : 1)
      if (choices[index]?.takesText) denyReasonMode = true
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choices[index]?.run()
      return
    }
    const digit = Number(event.key)
    if (Number.isInteger(digit) && digit >= 1 && digit <= choices.length) {
      event.preventDefault()
      index = digit - 1
      choices[index].run()
      return
    }
    // The first character of the reason opens the box and lands in it.
    if (choices[index]?.takesText && isTyping(event)) {
      event.preventDefault()
      denyReason += event.key
      denyReasonMode = true
    }
  }
</script>

<div
  bind:this={rootEl}
  class="rounded-md border border-line bg-elevated p-3 outline-none"
  tabindex="-1"
  onkeydown={onKey}
>
  <div class="text-xs font-medium text-default">Permission required</div>
  <div class="mt-1.5 text-xs text-muted">{reason}</div>

  <!-- What is waiting, and on what: the file when a diff was staged, else
       whatever the tool says the call is about. -->
  <div class="mt-2 flex min-w-0 items-center gap-2 text-2xs">
    <span class="shrink-0 text-dim"><PencilSimple width="12" height="12" /></span>
    <span class="shrink-0 text-dim">Awaiting approval</span>
    {#if change}
      <Icon icon={fileIcon(fileName)} class="size-3.5 shrink-0" />
      <span class="min-w-0 truncate font-mono text-default">{fileName}</span>
      {#if change.added > 0}<span class="shrink-0 text-green">+{change.added}</span>{/if}
      {#if change.removed > 0}<span class="shrink-0 text-red">−{change.removed}</span>{/if}
    {:else}
      {#if display?.title}
        <span class="shrink-0 font-medium text-default" title={item.name}>{display.title}</span>
      {:else}
        <span class="shrink-0 font-mono text-default">{item.name}</span>
      {/if}
      {#if message?.to}
        <span class="min-w-0 truncate text-default">{message.to}</span>
      {/if}
      {#if description}<span class="min-w-0 truncate text-default">{description}</span>{/if}
      {#if detail && !description && !command && detail !== message?.to}
        <span class="min-w-0 truncate font-mono text-muted">{detail}</span>
      {/if}
    {/if}
  </div>

  <!-- A call that carries a message — starting another agent is the one that
       asks — is decided on what it says, so the body is shown in full. -->
  {#if message}
    <div
      class="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap border-l-2 border-line pl-2 text-xs text-muted"
    >
      {message.text}
    </div>
  {/if}

  <!-- What a spawned agent will spend its tokens on, changeable before it starts. -->
  {#if item.spawn && spawnChoice}
    <div class="mt-2">
      <SpawnTargetPicker
        target={item.spawn}
        bind:choice={spawnChoice}
        {onRequestKey}
        {onAddEndpoint}
        onDone={focus}
      />
    </div>
  {/if}

  <!-- The arguments themselves, once the description has said what they are for. -->
  {#if !message && command}
    <CodeBlock
      code={command}
      language="shell"
      class="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line bg-canvas px-2 py-1 font-mono text-2xs text-muted"
    />
  {:else if !message && description && detail}
    <pre
      class="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap rounded border border-line bg-canvas px-2 py-1 font-mono text-2xs text-muted">{detail}</pre>
  {/if}

  {#if denyReasonMode}
    <textarea
      bind:this={reasonEl}
      class="mb-2 mt-2 h-16 w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs"
      placeholder="Reason for denying… Enter to send, Esc to go back"
      bind:value={denyReason}
      onkeydown={onReasonKey}
    ></textarea>
    <div class="flex gap-2">
      <button
        class="rounded-md bg-red px-3 py-1 text-xs text-action-fg"
        onclick={() => onDecide('deny', denyReason)}
      >
        Deny with reason
      </button>
      <button
        class="rounded-md border border-line px-3 py-1 text-xs hover:bg-hover"
        onclick={() => (denyReasonMode = false)}
      >
        Cancel
      </button>
    </div>
  {:else}
    <!-- Only the selected choice is marked. A pointer resting over the card by
         accident must not look like, or become, the selection. -->
    <div class="mt-2 flex flex-col">
      {#each choices as choice, choiceIndex (choice.label)}
        <button
          class="flex items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-xs outline-none"
          class:bg-hover={choiceIndex === index}
          onclick={choice.run}
        >
          <span class="w-3 shrink-0 text-2xs text-dim">{choiceIndex + 1}.</span>
          <span class="shrink-0 font-medium text-default">{choice.label}</span>
          <span class="min-w-0 truncate text-dim">{choice.detail}</span>
        </button>
      {/each}
    </div>

    <div class="mt-2 flex items-center gap-2 border-t border-line pt-2 text-2xs text-dim">
      <Info width="12" height="12" />
      <span class="min-w-0 flex-1 truncate">
        Use Tab / arrow keys to choose, then press Enter to confirm
      </span>
      <button
        class="shrink-0 rounded-md bg-action px-3 py-1 text-xs text-action-fg"
        onclick={() => choices[index]?.run()}
      >
        Confirm
      </button>
    </div>
  {/if}
</div>
