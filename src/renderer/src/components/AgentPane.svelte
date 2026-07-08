<script lang="ts">
  import { store, refreshRuntimes, openFileInEditor, respondPermission } from '../lib/store.svelte'
  import type { LogLine } from '../lib/store.svelte'
  import type { AgentRuntime, AgentConfig } from '../../../shared/types'
  import { parseAgentLines, toolSummary } from '../lib/agentStream'

  let prompt = $state('')
  let promptEl = $state<HTMLTextAreaElement>()
  let selectedAgent = $state<string>(localStorage.getItem('agent.selected') || '')
  let modeIndex = $state(0)
  let effortIndex = $state(0)
  let selectedModel = $state('')

  const agentNames = $derived(Object.keys(store.agentConfigs))
  const config = $derived<AgentConfig | undefined>(store.agentConfigs[selectedAgent])
  const modes = $derived(config?.modes || [])
  const efforts = $derived(config?.efforts || [])

  // Pick a default agent once configs load.
  $effect(() => {
    if (!selectedAgent && agentNames.length > 0) {
      const saved = localStorage.getItem('agent.selected') || ''
      selectedAgent = agentNames.includes(saved) ? saved : agentNames[0]
    }
  })

  // Reset per-agent selections when the agent changes.
  let lastAgent = ''
  $effect(() => {
    if (selectedAgent && selectedAgent !== lastAgent) {
      lastAgent = selectedAgent
      modeIndex = 0
      effortIndex = 0
      selectedModel = ''
      localStorage.setItem('agent.selected', selectedAgent)
    }
  })

  // ── Selected config values passed to the adapter ───────────────
  function launchOptions(): {
    prompt?: string
    mode?: string
    model?: string
    effort?: string
  } {
    return {
      prompt: prompt.trim() || undefined,
      mode: modes[modeIndex]?.value || undefined,
      model: selectedModel.trim() || undefined,
      effort: efforts[effortIndex]?.value || undefined
    }
  }

  // Mode chip color by intent. Falls back to dim for unknown adapters.
  function modeColor(label: string): string {
    if (label.includes('auto')) return 'text-green'
    if (label.includes('accept')) return 'text-violet'
    if (label.includes('plan')) return 'text-blue'
    if (label.includes('manual')) return 'text-amber'
    return 'text-dim'
  }

  const modeLabel = $derived(modes[modeIndex]?.label || 'default')
  const effortLabel = $derived(efforts[effortIndex]?.label || 'default')
  const modelLabel = $derived(selectedModel || 'default')

  function cycleAgent(): void {
    if (agentNames.length < 2) return
    const next = (agentNames.indexOf(selectedAgent) + 1) % agentNames.length
    selectedAgent = agentNames[next]
  }
  function cycleMode(): void {
    if (modes.length === 0) return
    modeIndex = (modeIndex + 1) % modes.length
  }
  function cycleEffort(): void {
    if (efforts.length === 0) return
    effortIndex = (effortIndex + 1) % efforts.length
  }
  function cycleModel(): void {
    const options = ['', ...(config?.models?.map((model) => model.value) || [])]
    if (options.length < 2) return
    const next = (options.indexOf(selectedModel) + 1) % options.length
    selectedModel = options[next]
  }

  // ── Slash command menu (type "/" in the prompt) ────────────────
  // Composite commands: one command per setting, each taking an argument
  // (e.g. "/effort high"). Typing "/" lists commands with descriptions; after
  // a command name, its argument values are offered.
  interface SlashArg {
    value: string
    description?: string
    apply: () => void
  }
  interface SlashCommand {
    name: string
    description: string
    args: SlashArg[]
  }
  interface SlashEntry {
    label: string
    description?: string
    apply: () => void
  }

  let slashDismissed = $state(false)
  let slashIndex = $state(0)

  // The "/token" being typed at the end of the prompt, if any. `rest` keeps
  // spaces so multi-word values ("manual review") and free-text models work.
  const slash = $derived.by(() => {
    const match = prompt.match(/(?:^|\s)(\/(.*))$/)
    if (!match) return null
    const token = match[1]
    return { start: prompt.length - token.length, rest: match[2] }
  })

  const slashCommands = $derived.by<SlashCommand[]>(() => {
    const commands: SlashCommand[] = []
    if (modes.length > 0) {
      commands.push({
        name: 'mode',
        description: 'Permission mode',
        args: modes.map((mode, index) => ({
          value: mode.label,
          description: mode.value,
          apply: () => (modeIndex = index)
        }))
      })
    }
    if (efforts.length > 0) {
      commands.push({
        name: 'effort',
        description: 'Reasoning effort',
        args: efforts.map((effort, index) => ({
          value: effort.label,
          description: effort.value || 'default',
          apply: () => (effortIndex = index)
        }))
      })
    }
    commands.push({
      name: 'model',
      description: 'Model to use (free text allowed)',
      args: [
        { value: 'default', description: 'server default', apply: () => (selectedModel = '') },
        ...(config?.models || []).map((model) => ({
          value: model.label,
          description: model.value,
          apply: () => (selectedModel = model.value)
        }))
      ]
    })
    return commands
  })

  function finishSlash(action: () => void): void {
    if (!slash) return
    action()
    prompt = prompt.slice(0, slash.start).replace(/\s+$/, '')
    promptEl?.focus()
  }

  const slashEntries = $derived.by<SlashEntry[]>(() => {
    if (!slash || slashDismissed) return []
    const rest = slash.rest
    const space = rest.indexOf(' ')

    // Command-selection phase: no argument typed yet.
    if (space === -1) {
      const query = rest.toLowerCase()
      return slashCommands
        .filter((command) => command.name.includes(query))
        .map((command) => ({
          label: `/${command.name}`,
          description: command.description,
          // Completing a command keeps the menu open on its arguments.
          apply: () => {
            if (!slash) return
            prompt = prompt.slice(0, slash.start) + `/${command.name} `
            slashIndex = 0
            promptEl?.focus()
          }
        }))
    }

    // Argument phase: a command is chosen, filter its values.
    const commandName = rest.slice(0, space).toLowerCase()
    const argQuery = rest.slice(space + 1).toLowerCase()
    const command = slashCommands.find((entry) => entry.name === commandName)
    if (!command) return []
    const entries: SlashEntry[] = command.args
      .filter((arg) => arg.value.toLowerCase().includes(argQuery))
      .map((arg) => ({ label: arg.value, description: arg.description, apply: () => finishSlash(arg.apply) }))

    // Free-text model value for CLIs without a model-list command (e.g. claude).
    if (command.name === 'model') {
      const raw = rest.slice(space + 1).trim()
      const exists = command.args.some((arg) => arg.value.toLowerCase() === raw.toLowerCase())
      if (raw && !exists) {
        entries.unshift({
          label: raw,
          description: 'custom model',
          apply: () => finishSlash(() => (selectedModel = raw))
        })
      }
    }
    return entries
  })
  const slashOpen = $derived(slashEntries.length > 0)

  $effect(() => {
    // Reset dismissal and selection whenever the typed token changes.
    slash?.rest
    slashDismissed = false
    slashIndex = 0
  })

  // ── "@" file-mention menu ──────────────────────────────────────
  // Flat file list for the selected worktree, loaded once per worktree.
  let worktreeFiles = $state<string[]>([])
  $effect(() => {
    const id = store.selectedWorktreeId
    if (!id) {
      worktreeFiles = []
      return
    }
    void window.workbench.files
      .listAll(id)
      .then((files) => (worktreeFiles = files))
      .catch(() => (worktreeFiles = []))
  })

  let mentionDismissed = $state(false)
  let mentionIndex = $state(0)

  // The "@token" being typed at the end of the prompt, if any.
  const mention = $derived.by(() => {
    const match = prompt.match(/(?:^|\s)@([^\s]*)$/)
    if (!match) return null
    const token = `@${match[1]}`
    return { start: prompt.length - token.length, query: match[1].toLowerCase() }
  })

  const mentionItems = $derived.by<string[]>(() => {
    if (!mention || mentionDismissed) return []
    return worktreeFiles.filter((file) => file.toLowerCase().includes(mention.query)).slice(0, 50)
  })
  const mentionOpen = $derived(mentionItems.length > 0)

  $effect(() => {
    mention?.query
    mentionDismissed = false
    mentionIndex = 0
  })

  function applyMention(path: string): void {
    if (!mention) return
    prompt = `${prompt.slice(0, mention.start)}@${path} `
    promptEl?.focus()
  }

  function baseName(path: string): string {
    return path.split('/').pop() || path
  }

  function onPromptKey(event: KeyboardEvent): void {
    // Shift+Tab cycles the mode regardless of menu state.
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault()
      cycleMode()
      return
    }
    if (slashOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        slashIndex = (slashIndex + 1) % slashEntries.length
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        slashIndex = (slashIndex - 1 + slashEntries.length) % slashEntries.length
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        slashEntries[slashIndex].apply()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        slashDismissed = true
        return
      }
    }
    if (mentionOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        mentionIndex = (mentionIndex + 1) % mentionItems.length
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        mentionIndex = (mentionIndex - 1 + mentionItems.length) % mentionItems.length
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        applyMention(mentionItems[mentionIndex])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        mentionDismissed = true
        return
      }
    }
    // Enter submits; Shift+Enter inserts a newline.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void launch()
    }
  }

  // ── Runtime ────────────────────────────────────────────────────
  const agents = $derived<AgentRuntime[]>(
    store.selectedWorktreeId ? store.agents[store.selectedWorktreeId] || [] : []
  )
  const isRunning = $derived(
    agents.some((agent) => agent.name === selectedAgent && agent.status === 'running')
  )

  const agentLines = $derived<LogLine[]>(
    (store.selectedWorktreeId ? store.logs[store.selectedWorktreeId] || [] : []).filter(
      (line) => line.source === 'agent'
    )
  )
  const items = $derived(parseAgentLines(agentLines.map((line) => line.line)))

  async function launch(): Promise<void> {
    if (!store.selectedWorktreeId || !selectedAgent) return
    try {
      await window.workbench.agents.start(store.selectedWorktreeId, selectedAgent, launchOptions())
      prompt = ''
      await refreshRuntimes(store.selectedWorktreeId)
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  async function stop(): Promise<void> {
    if (!store.selectedWorktreeId || !selectedAgent) return
    await window.workbench.agents.stop(store.selectedWorktreeId, selectedAgent)
    await refreshRuntimes(store.selectedWorktreeId)
  }

  // ── Interactive permission prompt ──────────────────────────────
  const pendingPermission = $derived(
    store.pendingPermissions.find(
      (request) => request.worktreeId === store.selectedWorktreeId && request.agent === selectedAgent
    ) || null
  )
  let denyReasonMode = $state(false)
  let denyReason = $state('')

  function approve(remember: boolean): void {
    if (!pendingPermission) return
    void respondPermission(pendingPermission.id, { behavior: 'allow', remember })
    denyReasonMode = false
    denyReason = ''
  }
  function deny(message: string): void {
    if (!pendingPermission) return
    void respondPermission(pendingPermission.id, {
      behavior: 'deny',
      message: message.trim() || 'Denied by user'
    })
    denyReasonMode = false
    denyReason = ''
  }
  function showInEditor(): void {
    if (pendingPermission?.path && store.selectedWorktreeId) {
      openFileInEditor(store.selectedWorktreeId, pendingPermission.path)
    }
  }

  function truncate(text: string, max = 600): string {
    return text.length > max ? text.slice(0, max) + '…' : text
  }

  // The file a tool card acts on, if any — makes the card open-in-editor.
  function filePath(input: Record<string, unknown>): string | null {
    if (typeof input.file_path === 'string') return input.file_path
    if (typeof input.path === 'string') return input.path
    return null
  }

  function openCard(input: Record<string, unknown>): void {
    const path = filePath(input)
    if (path && store.selectedWorktreeId) openFileInEditor(store.selectedWorktreeId, path)
  }

  // Tool results (e.g. a Read returning a whole file) are collapsed so the
  // output isn't flooded with file contents; click to expand.
  let expandedResults = $state<Record<string, boolean>>({})
  function toggleResult(key: string): void {
    expandedResults = { ...expandedResults, [key]: !expandedResults[key] }
  }
  function resultLabel(text: string, isError: boolean): string {
    if (isError) return text.split('\n')[0]
    return `result · ${text.length} chars`
  }
</script>

<div class="flex h-full flex-col">
  <div
    class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2 text-2xs font-semibold uppercase tracking-caps text-dim"
  >
    <span>Agent</span>
    {#if store.selectedWorktree}
      <span class="normal-case text-muted">· {store.selectedWorktree.name}</span>
    {/if}
  </div>

  {#if !store.selectedWorktreeId}
    <p class="px-3 py-3 text-xs text-dim">Select a worktree.</p>
  {:else}
    <!-- Output -->
    <div class="min-h-0 flex-1 overflow-auto px-3 py-2 text-xs leading-relaxed">
      {#each items as item (item.key)}
        {#if item.kind === 'text'}
          <div class="mb-2 whitespace-pre-wrap text-default">{item.text}</div>
        {:else if item.kind === 'tool'}
          {@const path = filePath(item.input)}
          <div class="mb-2 overflow-hidden rounded-md border border-line bg-surface">
            <button
              class="flex w-full items-center gap-2 border-b border-line px-2 py-1 text-left {path
                ? 'hover:bg-hover'
                : 'cursor-default'}"
              disabled={!path}
              onclick={() => openCard(item.input)}
            >
              <span class="font-mono text-2xs font-semibold text-violet">{item.tool}</span>
              {#if toolSummary(item.tool, item.input)}
                <span class="truncate font-mono text-2xs text-muted"
                  >{toolSummary(item.tool, item.input)}</span
                >
              {/if}
              {#if path}<span class="ml-auto shrink-0 text-2xs text-dim">open ↗</span>{/if}
            </button>
            {#if !toolSummary(item.tool, item.input)}
              <pre class="overflow-auto px-2 py-1 font-mono text-2xs text-dim">{truncate(
                  JSON.stringify(item.input, null, 2)
                )}</pre>
            {/if}
          </div>
        {:else if item.kind === 'tool-result'}
          <button
            class="mb-2 flex w-full items-center gap-2 rounded-md bg-canvas px-2 py-1 text-left font-mono text-2xs {item.isError
              ? 'text-red'
              : 'text-dim'}"
            onclick={() => toggleResult(item.key)}
          >
            <span class="shrink-0">{expandedResults[item.key] ? '▾' : '▸'}</span>
            <span class="truncate">{resultLabel(item.text, item.isError)}</span>
          </button>
          {#if expandedResults[item.key]}
            <pre
              class="mb-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-canvas px-2 py-1 font-mono text-2xs text-dim">{item.text}</pre>
          {/if}
        {:else}
          <pre class="mb-1 whitespace-pre-wrap font-mono text-2xs text-muted">{item.text}</pre>
        {/if}
      {/each}
      {#if items.length === 0}
        <p class="text-dim">No agent output yet. Write a prompt below and run.</p>
      {/if}
    </div>

    <!-- Input + config status line pinned at the bottom -->
    <div class="relative shrink-0 border-t border-line p-3">
      {#if pendingPermission}
        <!-- Permission prompt replaces the input until answered -->
        <div class="rounded-md border border-amber/40 bg-amber-soft p-2">
          <div class="mb-2 text-xs text-default">{pendingPermission.title}</div>
          {#if pendingPermission.path}
            <div class="mb-2 truncate font-mono text-2xs text-muted">{pendingPermission.path}</div>
          {/if}
          {#if denyReasonMode}
            <textarea
              class="mb-2 h-16 w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs"
              placeholder="Reason for denying…"
              bind:value={denyReason}
            ></textarea>
            <div class="flex gap-2">
              <button
                class="rounded-md bg-red px-3 py-1 text-xs text-action-fg"
                onclick={() => deny(denyReason)}
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
            <div class="flex flex-col gap-1.5">
              <button
                class="rounded-md bg-green px-3 py-1.5 text-left text-xs text-action-fg"
                onclick={() => approve(false)}
              >
                Yes
              </button>
              <button
                class="rounded-md bg-violet px-3 py-1.5 text-left text-xs text-action-fg"
                onclick={() => approve(true)}
              >
                Yes, don't ask again for this
              </button>
              {#if pendingPermission.path}
                <button
                  class="rounded-md border border-line px-3 py-1.5 text-left text-xs hover:bg-hover"
                  onclick={showInEditor}
                >
                  Show in editor
                </button>
              {/if}
              <button
                class="rounded-md border border-line px-3 py-1.5 text-left text-xs text-red hover:bg-hover"
                onclick={() => deny('')}
              >
                No
              </button>
              <button
                class="rounded-md border border-line px-3 py-1.5 text-left text-xs text-dim hover:bg-hover"
                onclick={() => (denyReasonMode = true)}
              >
                No, with reason…
              </button>
            </div>
          {/if}
        </div>
      {:else}
      {#if slashOpen}
        <!-- Slash menu floats above the input -->
        <div
          class="absolute bottom-full left-3 right-3 mb-1 max-h-56 overflow-auto rounded-md border border-line bg-elevated shadow-lg"
        >
          {#each slashEntries as entry, index (entry.label)}
            <button
              class="flex w-full items-center gap-3 px-2 py-1.5 text-left text-xs {index === slashIndex
                ? 'bg-action text-action-fg'
                : 'text-muted hover:bg-hover'}"
              onmousedown={(event) => {
                event.preventDefault()
                entry.apply()
              }}
            >
              <span class="font-mono font-medium">{entry.label}</span>
              {#if entry.description}
                <span class="ml-auto truncate font-mono text-2xs {index === slashIndex
                  ? 'text-action-fg/70'
                  : 'text-dim'}">{entry.description}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      {#if mentionOpen}
        <!-- File-mention menu floats above the input -->
        <div
          class="absolute bottom-full left-3 right-3 mb-1 max-h-56 overflow-auto rounded-md border border-line bg-elevated shadow-lg"
        >
          {#each mentionItems as file, index (file)}
            <button
              class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs {index ===
              mentionIndex
                ? 'bg-action text-action-fg'
                : 'text-muted hover:bg-hover'}"
              onmousedown={(event) => {
                event.preventDefault()
                applyMention(file)
              }}
            >
              <span class="font-mono font-medium">{baseName(file)}</span>
              <span
                class="ml-auto truncate font-mono text-2xs {index === mentionIndex
                  ? 'text-action-fg/70'
                  : 'text-dim'}">{file}</span
              >
            </button>
          {/each}
        </div>
      {/if}

      <textarea
        bind:this={promptEl}
        class="mb-2 h-20 w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs"
        placeholder="Prompt…  ( / options · @ files · Shift+Tab mode · Enter run )"
        bind:value={prompt}
        onkeydown={onPromptKey}
      ></textarea>

      <div class="flex items-center gap-3 text-2xs">
        <button class="flex items-center gap-1" title="Cycle agent" onclick={cycleAgent}>
          <span class="text-dim">agent</span>
          <span class="font-medium text-default">{selectedAgent || '—'}</span>
        </button>
        <button
          class="flex items-center gap-1"
          title="Cycle mode (Shift+Tab)"
          onclick={cycleMode}
          disabled={modes.length === 0}
        >
          <span class="text-dim">mode</span>
          <span class="font-medium {modeColor(modeLabel)}">{modeLabel}</span>
        </button>

        <button class="ml-auto flex items-center gap-1" title="Cycle model" onclick={cycleModel}>
          <span class="text-dim">model</span>
          <span class="font-medium text-default">{modelLabel}</span>
        </button>
        <button
          class="flex items-center gap-1"
          title="Cycle effort"
          onclick={cycleEffort}
          disabled={efforts.length === 0}
        >
          <span class="text-dim">effort</span>
          <span class="font-medium text-default">{effortLabel}</span>
        </button>

        {#if isRunning}
          <button
            class="rounded-md border border-line px-3 py-1 text-xs hover:bg-hover"
            onclick={stop}
          >
            ■ Stop
          </button>
        {/if}
      </div>
      {/if}
    </div>
  {/if}
</div>
