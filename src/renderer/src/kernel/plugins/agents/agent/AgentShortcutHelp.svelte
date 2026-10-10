<script lang="ts">
  // The agent pane's keyboard shortcuts, in place of the transcript. Plain on purpose;
  // the agent pane's overlays get a design pass of their own.

  import Kbd from '../../../../components/Kbd.svelte'
  import type { ShortcutRow } from '../../../../lib/agents/shortcutHelp'

  let {
    paneRows,
    composerRows,
    onClose
  }: {
    /** The pane's bindings, as the keymap has them now. */
    paneRows: ShortcutRow[]
    /** The composer's own keys. */
    composerRows: ShortcutRow[]
    onClose: () => void
  } = $props()

  /** Escape, ? and Enter put the help away. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' && event.key !== '?' && event.key !== 'Enter') return
    event.preventDefault()
    onClose()
  }

  /** Puts keyboard focus in the help, so its keys work as it opens. */
  function takeFocus(element: HTMLElement): void {
    element.focus()
  }
</script>

<!-- Replaces the transcript: Esc or ? brings the conversation back. -->
<div
  class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2 outline-none"
  role="application"
  aria-label="Keyboard shortcuts"
  data-testid="shortcut-help"
  tabindex="-1"
  use:takeFocus
  onkeydown={onKeydown}
>
  <div class="text-xs font-medium text-default">Keyboard shortcuts</div>

  {#each [{ title: 'Prompt', rows: composerRows }, { title: 'Agent pane', rows: paneRows }] as section (section.title)}
    <div class="text-2xs font-medium text-muted">{section.title}</div>
    <div class="flex flex-col gap-1">
      {#each section.rows as row, index (index)}
        <div class="flex items-start gap-2 text-2xs text-muted" data-testid="shortcut-row">
          <span class="flex w-28 shrink-0 flex-wrap gap-1">
            <Kbd>{row.keys}</Kbd>
          </span>
          <span class="min-w-0 flex-1">{row.description}</span>
        </div>
      {/each}
    </div>
  {/each}

  <p class="text-2xs text-dim">Esc or ? to close.</p>
</div>
