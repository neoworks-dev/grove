<script lang="ts">
  import {
    store,
    refreshRuntimes,
    openFileInEditor,
    respondPermission,
    respondDialog,
    seedAgentTranscript,
    resetAgentChat
  } from '../lib/store.svelte'
  import { parseQuestions, buildAnswerResult } from '../lib/agentDialog'
  import type { LogLine } from '../lib/store.svelte'
  import type { AgentRuntime, AgentConfig } from '../../../shared/types'
  import { parseAgentLines, parseAgentMeta, toolSummary } from '../lib/agentStream'
  import { renderMarkdown } from '../lib/markdown'

  let prompt = $state('')
  let promptEl = $state<HTMLTextAreaElement>()
  let selectedAgent = $state<string>(localStorage.getItem('agent.selected') || '')
  let modeIndex = $state(0)
  let effortIndex = $state(0)
  let selectedModel = $state('')

  // Submitted-prompt history (most recent first), navigated with Arrow Up/Down.
  function loadHistory(): string[] {
    try {
      const parsed = JSON.parse(localStorage.getItem('agent.history') || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  let history = $state<string[]>(loadHistory())
  let historyIndex = $state(-1) // -1 = not navigating
  let draft = $state('') // in-progress text stashed while navigating

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
    // Prompt history: Arrow Up recalls older entries (from the caret start),
    // Arrow Down walks back toward the in-progress draft.
    if (history.length > 0) {
      if (event.key === 'ArrowUp' && (historyIndex !== -1 || caretAtStart())) {
        event.preventDefault()
        navigateHistory(1)
        return
      }
      if (event.key === 'ArrowDown' && historyIndex !== -1) {
        event.preventDefault()
        navigateHistory(-1)
        return
      }
    }
    // Enter submits; Shift+Enter inserts a newline.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void launch()
    }
  }

  function caretAtStart(): boolean {
    return !!promptEl && promptEl.selectionStart === 0 && promptEl.selectionEnd === 0
  }

  function navigateHistory(direction: 1 | -1): void {
    if (direction === 1) {
      if (historyIndex === -1) {
        draft = prompt
        historyIndex = 0
      } else {
        historyIndex = Math.min(historyIndex + 1, history.length - 1)
      }
      prompt = history[historyIndex]
    } else {
      if (historyIndex <= 0) {
        historyIndex = -1
        prompt = draft
      } else {
        historyIndex -= 1
        prompt = history[historyIndex]
      }
    }
    // Place the caret at the end after the value updates.
    const end = prompt.length
    queueMicrotask(() => {
      if (promptEl) promptEl.setSelectionRange(end, end)
    })
  }

  function pushHistory(text: string): void {
    if (!text.trim()) return
    history = [text, ...history.filter((entry) => entry !== text)].slice(0, 100)
    localStorage.setItem('agent.history', JSON.stringify(history))
    historyIndex = -1
    draft = ''
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
  const rawLines = $derived(agentLines.map((line) => line.line))
  const items = $derived(parseAgentLines(rawLines))
  const meta = $derived(parseAgentMeta(rawLines))

  // ── Working-state indicator ────────────────────────────────────
  // What the agent is doing right now, inferred from the latest transcript item.
  const workState = $derived.by(() => {
    if (!isRunning) return ''
    const last = items[items.length - 1]
    if (!last) return 'thinking'
    if (last.kind === 'tool') return `using ${last.tool}`
    if (last.kind === 'text') return 'writing'
    if (last.kind === 'tool-result') return 'working'
    return 'thinking'
  })

  const FUNNY_MESSAGES = [
    'reticulating splines…',
    'bribing the compiler…',
    'summoning semicolons…',
    'consulting the rubber duck…',
    'untangling the yak…',
    'negotiating with the borrow checker…',
    'feeding the hamsters…',
    'aligning the tab stops…',
    'blaming the cache…',
    'warming up the tubes…'
  ]
  // Rotate slowly as work progresses; stable within a render.
  const funnyMessage = $derived(FUNNY_MESSAGES[items.length % FUNNY_MESSAGES.length])

  function formatTokens(count: number): string {
    if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
    return String(count)
  }

  async function launch(): Promise<void> {
    if (!store.selectedWorktreeId || !selectedAgent) return
    try {
      await window.workbench.agents.start(store.selectedWorktreeId, selectedAgent, launchOptions())
      pushHistory(prompt)
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

  // ── Transcript replay + New chat ───────────────────────────────
  // Restore a chat after a restart: when a (worktree, agent) has no in-memory
  // history yet, load its persisted transcript from disk once.
  const replayed = new Set<string>()
  $effect(() => {
    const worktreeId = store.selectedWorktreeId
    const agent = selectedAgent
    if (!worktreeId || !agent) return
    const replayKey = `${worktreeId}::${agent}`
    if (replayed.has(replayKey)) return
    const hasAgentLines = (store.logs[worktreeId] || []).some((line) => line.source === 'agent')
    replayed.add(replayKey)
    if (hasAgentLines) return
    void window.workbench.agents
      .transcript(worktreeId, agent)
      .then((lines) => seedAgentTranscript(worktreeId, agent, lines))
      .catch(() => {})
  })

  async function newChat(): Promise<void> {
    if (!store.selectedWorktreeId || !selectedAgent) return
    if (!confirm('Start a new chat? This clears the current conversation and its memory.')) return
    const worktreeId = store.selectedWorktreeId
    await resetAgentChat(worktreeId, selectedAgent)
    replayed.delete(`${worktreeId}::${selectedAgent}`)
    await refreshRuntimes(worktreeId)
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
  function showChange(): void {
    // Prefer the proposed-change diff; fall back to opening the file.
    if (store.proposedDiff) {
      store.centerView = 'diff'
    } else if (pendingPermission?.path && store.selectedWorktreeId) {
      openFileInEditor(store.selectedWorktreeId, pendingPermission.path)
    }
  }

  // ── Agent question dialog ──────────────────────────────────────
  const pendingDialog = $derived(
    store.pendingDialogs.find(
      (request) => request.worktreeId === store.selectedWorktreeId && request.agent === selectedAgent
    ) || null
  )
  const dialogQuestions = $derived(pendingDialog ? parseQuestions(pendingDialog.payload) : [])
  let dialogSelections = $state<string[][]>([])

  // Reset selections whenever the pending dialog changes.
  $effect(() => {
    pendingDialog?.id
    dialogSelections = dialogQuestions.map(() => [])
  })

  const dialogReady = $derived(
    dialogQuestions.length > 0 &&
      dialogQuestions.every((_question, index) => (dialogSelections[index]?.length || 0) > 0)
  )

  function toggleOption(questionIndex: number, label: string, multiSelect: boolean): void {
    const current = dialogSelections[questionIndex] || []
    let next: string[]
    if (multiSelect) {
      next = current.includes(label) ? current.filter((item) => item !== label) : [...current, label]
    } else {
      next = [label]
    }
    dialogSelections = dialogSelections.map((selection, index) =>
      index === questionIndex ? next : selection
    )
  }

  function submitDialog(): void {
    if (!pendingDialog) return
    void respondDialog(pendingDialog.id, {
      behavior: 'completed',
      result: buildAnswerResult(dialogQuestions, dialogSelections)
    })
  }

  function cancelDialog(): void {
    if (!pendingDialog) return
    void respondDialog(pendingDialog.id, { behavior: 'cancelled' })
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

  // Tool cards show a one-line summary; expand to see the full command / input.
  let expandedTools = $state<Record<string, boolean>>({})
  function toggleTool(key: string): void {
    expandedTools = { ...expandedTools, [key]: !expandedTools[key] }
  }

  // Full, untruncated detail for a tool card (the whole command or input JSON).
  function toolDetail(tool: string, input: Record<string, unknown>): string {
    if (typeof input.command === 'string') return input.command
    return JSON.stringify(input, null, 2)
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
    {#if store.selectedWorktreeId && items.length > 0}
      <button
        class="ml-auto rounded border border-line px-2 py-0.5 text-2xs normal-case tracking-normal text-dim hover:text-default"
        title="New chat (clears conversation memory)"
        onclick={newChat}
      >
        ＋ New chat
      </button>
    {/if}
  </div>

  {#if !store.selectedWorktreeId}
    <p class="px-3 py-3 text-xs text-dim">Select a worktree.</p>
  {:else}
    <!-- Chat transcript -->
    <div class="min-h-0 flex-1 overflow-auto px-3 py-3 text-xs leading-relaxed">
      {#each items as item (item.key)}
        {#if item.kind === 'user'}
          <!-- User message: distinct bubble, right-aligned. -->
          <div class="mb-3 flex justify-end">
            <div
              class="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm border border-blue/30 bg-blue-soft px-3 py-2 text-default"
            >
              {item.text}
            </div>
          </div>
        {:else if item.kind === 'text'}
          <!-- Assistant message: markdown-rendered. -->
          <div class="agent-markdown prose mb-3 max-w-none text-xs text-default">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html renderMarkdown(item.text)}
          </div>
        {:else if item.kind === 'tool'}
          {@const path = filePath(item.input)}
          {@const summary = toolSummary(item.tool, item.input)}
          <div class="mb-2 overflow-hidden rounded-md border border-line bg-surface">
            <div class="flex w-full items-center gap-2 border-b border-line px-2 py-1">
              <button
                class="flex min-w-0 flex-1 items-center gap-2 text-left"
                onclick={() => toggleTool(item.key)}
                title="Expand full command"
              >
                <span class="shrink-0 text-2xs text-dim">{expandedTools[item.key] ? '▾' : '▸'}</span>
                <span class="shrink-0 font-mono text-2xs font-semibold text-violet">{item.tool}</span
                >
                {#if summary}
                  <span class="truncate font-mono text-2xs text-muted">{summary}</span>
                {/if}
              </button>
              {#if path}
                <button
                  class="ml-auto shrink-0 text-2xs text-dim hover:text-default"
                  onclick={() => openCard(item.input)}>open ↗</button
                >
              {/if}
            </div>
            {#if expandedTools[item.key]}
              <pre
                class="max-h-72 overflow-auto whitespace-pre-wrap px-2 py-1.5 font-mono text-2xs text-muted">{toolDetail(
                  item.tool,
                  item.input
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

    <!-- Working-state bar: live indicator, funny status, token count, state. -->
    {#if isRunning}
      <div
        class="flex shrink-0 items-center gap-2 border-t border-line bg-elevated px-3 py-1.5 text-2xs"
      >
        <span class="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-green"></span>
        <span class="font-medium text-default">{workState}</span>
        <span class="ml-auto truncate italic text-dim">{funnyMessage}</span>
        <span class="shrink-0 font-mono text-muted" title="input + output tokens"
          >{formatTokens(meta.totalTokens)} tok</span
        >
      </div>
    {/if}

    <!-- Input + config status line pinned at the bottom -->
    <div class="relative shrink-0 border-t border-line p-3">
      {#if pendingDialog}
        <!-- Agent question: render the questions + options and return the answer -->
        <div class="rounded-md border border-blue/40 bg-blue-soft p-2">
          {#each dialogQuestions as question, questionIndex (questionIndex)}
            <div class="mb-3 last:mb-1">
              {#if question.header}
                <div class="mb-0.5 text-2xs font-semibold uppercase tracking-caps text-blue">
                  {question.header}
                </div>
              {/if}
              <div class="mb-1.5 text-xs text-default">{question.question}</div>
              <div class="flex flex-col gap-1">
                {#each question.options as option (option.label)}
                  {@const selected = (dialogSelections[questionIndex] || []).includes(option.label)}
                  <button
                    class="rounded-md border px-2 py-1.5 text-left text-xs {selected
                      ? 'border-blue bg-blue/15 text-default'
                      : 'border-line hover:bg-hover text-muted'}"
                    onclick={() => toggleOption(questionIndex, option.label, question.multiSelect)}
                  >
                    <span class="font-medium">{option.label}</span>
                    {#if option.description}
                      <span class="block text-2xs text-dim">{option.description}</span>
                    {/if}
                  </button>
                {/each}
              </div>
            </div>
          {/each}
          <div class="flex gap-2">
            <button
              class="rounded-md bg-action px-3 py-1 text-xs text-action-fg disabled:opacity-40"
              disabled={!dialogReady}
              onclick={submitDialog}
            >
              Answer
            </button>
            <button
              class="rounded-md border border-line px-3 py-1 text-xs text-dim hover:bg-hover"
              onclick={cancelDialog}
            >
              Cancel
            </button>
          </div>
        </div>
      {:else if pendingPermission}
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
                  onclick={showChange}
                >
                  Show in diff editor
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
        placeholder="Prompt…  ( / options · @ files · ↑↓ history · Shift+Tab mode · Enter run )"
        bind:value={prompt}
        onkeydown={onPromptKey}
        oninput={() => (historyIndex = -1)}
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
