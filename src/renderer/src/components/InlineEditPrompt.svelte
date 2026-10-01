<script lang="ts">
  // Floating inline-edit prompt, hovering just above the selection inside a
  // NvimPane (so it doesn't cover the selected code). Enter dispatches the edit;
  // Shift+Enter inserts a newline; Escape cancels. Its model picker is the
  // composer's own ModelMenu, and configures the dedicated inline task without
  // changing the Agent pane. A plain textarea keeps leader and nvim keys from
  // hijacking prompt typing.
  import { inlineEdit } from '../lib/inlineEdit.svelte'
  import { nvimSessionFor } from '../lib/nvim/registry'
  import { catalog } from '../lib/agents/catalog.svelte'
  import { encodeModelSelection, findRoute } from '../lib/agents/modelSelection'
  import ModelMenu from '../kernel/plugins/agents/agent/ModelMenu.svelte'
  import CredentialPrompt from '../kernel/plugins/agents/agent/CredentialPrompt.svelte'
  import EndpointEditor from '../kernel/plugins/agents/agent/EndpointEditor.svelte'

  let { leafId }: { leafId: string } = $props()

  let inputEl = $state<HTMLTextAreaElement>()
  let boxEl = $state<HTMLDivElement>()
  let text = $state('')
  let placedTop = $state(0)

  const open = $derived(inlineEdit.promptOpen && inlineEdit.promptLeafId === leafId)

  const GAP = 4

  // Roughly how tall the model menu opens: its search field and its list at
  // `max-h-96`. It opens above its button when that much room is there.
  const MODEL_MENU_HEIGHT = 440

  let modelMenuOpen = $state(false)
  let modelMenuBelow = $state(false)
  let modelPicker = $state<HTMLDivElement>()
  let credentialRequest = $state<{ provider: string; variables: string[] } | null>(null)
  let addingEndpoint = $state(false)

  const selection = $derived(inlineEdit.modelSelection)
  const selectedModel = $derived(findRoute(catalog.models, selection))

  /** The model as the composer names it, or the raw selection when the harness no longer lists it. */
  const modelName = $derived.by(() => {
    if (selectedModel) return selectedModel.entry.label
    return inlineEdit.modelLabel
  })

  $effect(() => {
    if (!open) modelMenuOpen = false
  })

  $effect(() => {
    if (!open) return
    queueMicrotask(() => inputEl?.focus())
  })

  // Place the box above the selection's first line; if there isn't room above,
  // drop it just below that line. Centered placement is handled purely by CSS.
  $effect(() => {
    if (!open || inlineEdit.promptCentered) return
    void inlineEdit.promptAnchorY
    queueMicrotask(() => {
      if (!boxEl) return
      const anchor = inlineEdit.promptAnchorY
      const above = anchor - boxEl.offsetHeight - GAP
      if (above >= 0) {
        placedTop = above
        return
      }
      const lineHeight = nvimSessionFor(leafId)?.cellHeight || 18
      placedTop = anchor + lineHeight + GAP
    })
  })

  /** Opens the model menu on whichever side of its button has room, or closes it. */
  function toggleModelMenu(): void {
    if (modelMenuOpen) {
      closeModelMenu()
      return
    }
    modelMenuBelow = !roomAbove()
    modelMenuOpen = true
  }

  /** Whether the menu fits between the button and the top of the editor. */
  function roomAbove(): boolean {
    const editor = boxEl?.parentElement?.offsetParent
    if (!modelPicker || !editor) return true
    const button = modelPicker.getBoundingClientRect()
    const bounds = editor.getBoundingClientRect()
    const above = button.top - bounds.top
    if (above >= MODEL_MENU_HEIGHT) return true
    return above >= bounds.bottom - button.bottom
  }

  /** Closes the model menu and hands the keyboard back to the prompt. */
  function closeModelMenu(): void {
    modelMenuOpen = false
    inputEl?.focus()
  }

  /** Stores the picked route as the inline task's model. */
  function pickModel(provider: string, model: string): void {
    inlineEdit.setModel(encodeModelSelection({ provider, model }))
    closeModelMenu()
  }

  /** Closes the menu when a press lands anywhere outside it. */
  function onWindowPointerDown(event: PointerEvent): void {
    if (!modelMenuOpen || !modelPicker) return
    if (modelPicker.contains(event.target as Node)) return
    modelMenuOpen = false
  }

  /** Keys typed into the menu are its own; Escape closes it rather than the prompt. */
  function onModelPickerKey(event: KeyboardEvent): void {
    event.stopPropagation()
    if (event.key !== 'Escape') return
    event.preventDefault()
    closeModelMenu()
  }

  /** A stored key or a new endpoint changes which models there are, so they are re-read. */
  async function reloadModels(changed: boolean): Promise<void> {
    if (!changed) return
    await catalog.reload()
    await inlineEdit.loadModels()
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      text = ''
      inlineEdit.cancelPrompt()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      const trimmed = text.trim()
      text = ''
      if (trimmed) void inlineEdit.submitPrompt(trimmed)
      else inlineEdit.cancelPrompt()
    }
  }
</script>

{#if open}
  <!-- Inset past the line-number gutter (left) and clear of the minimap (right)
       so the box never overlaps either. Capped width keeps it compact. -->
  <div
    class="absolute left-14 right-[72px] z-30 {inlineEdit.promptCentered
      ? 'top-1/2 -translate-y-1/2'
      : ''}"
    style={inlineEdit.promptCentered ? '' : `top: ${placedTop}px`}
  >
    <div
      bind:this={boxEl}
      class="max-w-[520px] rounded-lg border border-line bg-elevated shadow-xl"
    >
      <div class="flex items-center gap-2 px-2.5 pt-1.5 text-2xs text-dim">
        <span class="font-medium text-muted">Inline edit</span>
        <span class="min-w-0 flex-1 truncate font-mono">@{inlineEdit.promptRefLabel}</span>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="relative" bind:this={modelPicker} onkeydown={onModelPickerKey}>
          <button
            class="flex items-center gap-1.5 rounded border border-line px-2 py-0.5 hover:bg-hover"
            title="Model used for inline edits; Agent pane sessions keep their own model"
            onclick={toggleModelMenu}
          >
            <span class="max-w-[12rem] truncate font-medium text-default">{modelName}</span>
            <span class="text-dim">▾</span>
          </button>
          {#if modelMenuOpen}
            <ModelMenu
              models={catalog.models}
              provider={selection?.provider || ''}
              model={selection?.model || ''}
              switchCostWarning=""
              boundary={boxEl}
              below={modelMenuBelow}
              acceptsTypedId={false}
              onPick={pickModel}
              onRequestKey={(request) => {
                modelMenuOpen = false
                credentialRequest = request
              }}
              onAddEndpoint={() => {
                modelMenuOpen = false
                addingEndpoint = true
              }}
            />
          {/if}
        </div>
        <span class="rounded bg-surface px-1.5 py-0.5 uppercase tracking-wide">
          {inlineEdit.mode}
        </span>
      </div>
      <textarea
        bind:this={inputEl}
        bind:value={text}
        onkeydown={onKey}
        rows="2"
        placeholder="Describe the change… (Enter to run, Esc to cancel)"
        class="w-full resize-none bg-transparent px-2.5 py-2 text-sm text-default outline-none placeholder:text-dim"
      ></textarea>
    </div>
  </div>
{/if}

<svelte:window onpointerdown={onWindowPointerDown} />

{#if addingEndpoint}
  <EndpointEditor
    onClose={(saved) => {
      addingEndpoint = false
      void reloadModels(saved)
    }}
  />
{/if}

{#if credentialRequest}
  <CredentialPrompt
    provider={credentialRequest.provider}
    variables={credentialRequest.variables}
    onClose={(stored) => {
      credentialRequest = null
      void reloadModels(stored)
    }}
  />
{/if}
