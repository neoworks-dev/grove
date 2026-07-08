<script lang="ts">
  import {
    store,
    refreshRuntimes,
    openFileInEditor,
    respondPermission,
    respondDialog,
    seedAgentTranscript,
    resetAgentChat,
    refreshChats,
    renameChat,
    resumeChat
  } from '../lib/store.svelte'
  import { parseQuestions, buildAnswerResult } from '../lib/agentDialog'
  import WaveSpinner from './WaveSpinner.svelte'
  import type { LogLine } from '../lib/store.svelte'
  import type { AgentRuntime, AgentConfig } from '../../../shared/types'
  import { parseAgentLines, parseAgentMeta, toolSummary } from '../lib/agentStream'
  import { renderMarkdown } from '../lib/markdown'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'

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
      agentNavActive = false
      focusedSubagentKey = null
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
    // Action commands run immediately on selection instead of offering args.
    run?: () => void
    // Accept a free-text argument (e.g. a model name or chat name).
    freeText?: (raw: string) => void
    freeTextHint?: string
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
      ],
      freeText: (raw) => (selectedModel = raw),
      freeTextHint: 'custom model'
    })
    commands.push({
      name: 'clear',
      description: 'Clear this chat (new conversation)',
      args: [],
      run: clearChat
    })
    commands.push({
      name: 'rename',
      description: 'Name this chat',
      args: [],
      freeText: renameCurrentChat,
      freeTextHint: 'chat name'
    })
    if (currentChats && currentChats.chats.length > 0) {
      commands.push({
        name: 'resume',
        description: 'Resume a previous chat',
        args: currentChats.chats.map((chat) => ({
          value: chat.name,
          description: chat.id === currentChats.activeId ? 'current' : 'resume',
          apply: () => resumeCurrentChat(chat.id)
        }))
      })
    }
    return commands
  })

  const chatsKey = $derived(`${store.selectedWorktreeId}::${selectedAgent}`)
  const currentChats = $derived(store.agentChats[chatsKey])

  // Keep the chat list current for /resume and /rename.
  $effect(() => {
    if (store.selectedWorktreeId && selectedAgent) {
      void refreshChats(store.selectedWorktreeId, selectedAgent)
    }
  })

  function clearChat(): void {
    if (!store.selectedWorktreeId) return
    void resetAgentChat(store.selectedWorktreeId, selectedAgent)
  }
  function renameCurrentChat(name: string): void {
    if (!store.selectedWorktreeId || !currentChats || !name.trim()) return
    void renameChat(store.selectedWorktreeId, selectedAgent, currentChats.activeId, name.trim())
  }
  function resumeCurrentChat(chatId: string): void {
    if (!store.selectedWorktreeId) return
    void resumeChat(store.selectedWorktreeId, selectedAgent, chatId)
  }

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
          // Action commands run at once; others open their argument list.
          apply: () => {
            if (!slash) return
            if (command.run) {
              finishSlash(command.run)
              return
            }
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

    // Free-text argument (e.g. a custom model name, or a chat name for /rename).
    if (command.freeText) {
      const raw = rest.slice(space + 1).trim()
      const exists = command.args.some((arg) => arg.value.toLowerCase() === raw.toLowerCase())
      if (raw && !exists) {
        const apply = command.freeText
        entries.unshift({
          label: raw,
          description: command.freeTextHint || 'custom',
          apply: () => finishSlash(() => apply(raw))
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
    // Active-agents list: when the prompt is empty and subagents exist, Arrow
    // keys navigate the list and Enter opens the selected subagent's transcript.
    if (subagents.length > 0 && prompt.length === 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (!agentNavActive) {
          agentNavActive = true
          agentIndex = 0
        } else {
          agentIndex = Math.min(agentIndex + 1, subagents.length - 1)
        }
        return
      }
      if (agentNavActive && event.key === 'ArrowUp') {
        event.preventDefault()
        if (agentIndex === 0) agentNavActive = false
        else agentIndex -= 1
        return
      }
      if (agentNavActive && event.key === 'Enter') {
        event.preventDefault()
        focusSubagent(subagents[agentIndex].key)
        return
      }
      if (agentNavActive && event.key === 'Escape') {
        event.preventDefault()
        agentNavActive = false
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

  // ── Subagents (Task tool spawns) ───────────────────────────────
  // Derived from the main stream: each Task tool call is a subagent, running
  // until its tool-result arrives.
  interface Subagent {
    key: string
    type: string
    description: string
    running: boolean
  }
  const subagents = $derived.by<Subagent[]>(() => {
    const resultKeys = new Set(
      items.filter((item) => item.kind === 'tool-result').map((item) => item.key)
    )
    const list: Subagent[] = []
    for (const item of items) {
      // Modern SDK names the subagent tool `Agent`; older builds used `Task`.
      if (item.kind !== 'tool' || (item.tool !== 'Agent' && item.tool !== 'Task')) continue
      const input = item.input
      list.push({
        key: item.key,
        type: String(input.subagent_type || 'agent'),
        description: String(input.description || input.prompt || ''),
        running: !resultKeys.has(`result:${item.key}`)
      })
    }
    return list
  })

  let agentNavActive = $state(false)
  let agentIndex = $state(0)
  let focusedSubagentKey = $state<string | null>(null)

  $effect(() => {
    if (agentIndex >= subagents.length) agentIndex = Math.max(0, subagents.length - 1)
  })

  // The transcript shows all items, or just one subagent's Task card + result
  // when a subagent is focused from the list.
  const visibleItems = $derived.by(() => {
    if (!focusedSubagentKey) return items
    const resultKey = `result:${focusedSubagentKey}`
    return items.filter((item) => item.key === focusedSubagentKey || item.key === resultKey)
  })

  // ── Transcript auto-scroll ─────────────────────────────────────
  // Follow new output as it streams in, but yield to the user the moment they
  // scroll up to read back — re-engage once they return to the bottom.
  let transcriptViewport = $state<HTMLDivElement>()
  let stuckToBottom = $state(true)
  const AUTO_SCROLL_THRESHOLD = 40 // px from the bottom that still counts as "pinned"

  function onTranscriptScroll(): void {
    if (!transcriptViewport) return
    const distanceFromBottom =
      transcriptViewport.scrollHeight -
      transcriptViewport.scrollTop -
      transcriptViewport.clientHeight
    stuckToBottom = distanceFromBottom < AUTO_SCROLL_THRESHOLD
  }

  $effect(() => {
    // Re-run whenever the transcript changes (new items or streamed text).
    void visibleItems
    if (!stuckToBottom || !transcriptViewport) return
    const viewport = transcriptViewport
    requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight
    })
  })

  function focusSubagent(key: string): void {
    focusedSubagentKey = key
    agentNavActive = false
    expandedTools = { ...expandedTools, [key]: true }
    expandedResults = { ...expandedResults, [`result:${key}`]: true }
  }

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
      // Sending a new prompt re-pins the view to the newest output.
      stuckToBottom = true
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

  // Arrow-key-navigable choices for the permission prompt. "Show in diff editor"
  // only appears when the request carries a file path.
  interface PermissionChoice {
    label: string
    class: string
    run: () => void
  }
  const permissionChoices = $derived.by<PermissionChoice[]>(() => {
    if (!pendingPermission) return []
    const choices: PermissionChoice[] = [
      { label: 'Yes', class: 'bg-green text-action-fg', run: () => approve(false) },
      {
        label: "Yes, don't ask again for this",
        class: 'bg-violet text-action-fg',
        run: () => approve(true)
      }
    ]
    if (pendingPermission.path) {
      choices.push({
        label: 'Show in diff editor',
        class: 'border border-line hover:bg-hover',
        run: showChange
      })
    }
    choices.push({ label: 'No', class: 'border border-line text-red hover:bg-hover', run: () => deny('') })
    choices.push({
      label: 'No, with reason…',
      class: 'border border-line text-dim hover:bg-hover',
      run: () => (denyReasonMode = true)
    })
    return choices
  })

  let permissionIndex = $state(0)
  let permissionEl = $state<HTMLDivElement>()

  // Reset the highlight for each new request.
  $effect(() => {
    pendingPermission?.id
    permissionIndex = 0
  })

  // Focus the prompt so arrow keys and Enter reach it (nothing else is focused
  // while the prompt replaces the input).
  $effect(() => {
    if (pendingPermission && !denyReasonMode) {
      queueMicrotask(() => permissionEl?.focus())
    }
  })

  function onPermissionKey(event: KeyboardEvent): void {
    if (denyReasonMode) return
    const count = permissionChoices.length
    if (count === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      permissionIndex = (permissionIndex + 1) % count
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      permissionIndex = (permissionIndex - 1 + count) % count
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      permissionChoices[permissionIndex].run()
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
  let dialogNotes = $state('')
  let notesOpen = $state(false)
  let notesEl = $state<HTMLTextAreaElement>()

  // Reset per-dialog state whenever the pending dialog changes.
  $effect(() => {
    pendingDialog?.id
    dialogSelections = dialogQuestions.map(() => [])
    dialogNotes = ''
    notesOpen = false
  })

  // Ready when every question has a pick, or the user wrote free-form notes.
  const dialogReady = $derived(
    dialogQuestions.length > 0 &&
      (dialogNotes.trim().length > 0 ||
        dialogQuestions.every((_question, index) => (dialogSelections[index]?.length || 0) > 0))
  )

  function openNotes(): void {
    notesOpen = true
    queueMicrotask(() => notesEl?.focus())
  }

  // Press "n" in the chooser to jot free-form notes (unless already typing).
  function onDialogKey(event: KeyboardEvent): void {
    const tag = (event.target as HTMLElement)?.tagName
    if (event.key === 'n' && !notesOpen && tag !== 'TEXTAREA' && tag !== 'INPUT') {
      event.preventDefault()
      openNotes()
    }
  }

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
      result: buildAnswerResult(dialogQuestions, dialogSelections, dialogNotes)
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
    <FloatingScrollbar class="min-h-0 flex-1" bind:viewport={transcriptViewport} onscroll={onTranscriptScroll}>
      <div class="px-3 py-3 text-xs leading-relaxed">
      {#if focusedSubagentKey}
        <button
          class="-mx-3 mb-3 flex w-[calc(100%+1.5rem)] items-center gap-2 border-y border-line bg-surface px-3 py-1.5 text-2xs text-dim hover:text-default"
          onclick={() => (focusedSubagentKey = null)}
        >
          ← Back to full chat
        </button>
      {/if}
      {#each visibleItems as item (item.key)}
        {#if item.kind === 'user'}
          <!-- User message: full-width band tinted like the logo leaves. -->
          <div
            class="-mx-3 mb-3 whitespace-pre-wrap border-y border-green/30 bg-green-soft px-3 py-2 text-default"
          >
            {item.text}
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
    </FloatingScrollbar>

    <!-- Working-state bar: live indicator, funny status, token count, state. -->
    {#if isRunning}
      <div
        class="flex shrink-0 items-center gap-2 border-t border-line bg-elevated px-3 py-1.5 text-2xs"
      >
        <span class="shrink-0 text-green"><WaveSpinner /></span>
        <span class="font-medium text-default">{workState}</span>
        <span class="ml-auto truncate italic text-dim">{funnyMessage}</span>
        <span class="shrink-0 font-mono text-muted" title="input + output tokens"
          >{formatTokens(meta.totalTokens)} tok</span
        >
      </div>
    {/if}

    <!-- Active agents: subagents spawned via the Task tool. ↓ to navigate,
         Enter to open one's transcript. -->
    {#if subagents.length > 0}
      <div class="shrink-0 border-t border-line bg-elevated px-2 py-1.5">
        <div class="mb-1 px-1 text-2xs uppercase tracking-caps text-dim">
          Agents · <span class="normal-case tracking-normal">↓ navigate · enter open</span>
        </div>
        <div class="flex flex-col gap-0.5">
          {#each subagents as agent, index (agent.key)}
            <button
              class="flex items-center gap-2 rounded px-2 py-1 text-left text-2xs {agentNavActive &&
              index === agentIndex
                ? 'bg-action text-action-fg'
                : 'text-muted hover:bg-hover'} {agent.key === focusedSubagentKey
                ? 'ring-1 ring-green'
                : ''}"
              onclick={() => focusSubagent(agent.key)}
            >
              {#if agent.running}
                <span class="shrink-0 text-green"><WaveSpinner /></span>
              {:else}
                <span class="shrink-0 text-dim">✓</span>
              {/if}
              <span class="shrink-0 font-mono font-semibold text-violet">{agent.type}</span>
              {#if agent.description}
                <span class="truncate text-muted">{agent.description}</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Input + config status line pinned at the bottom -->
    <div class="relative shrink-0 border-t border-line p-3">
      {#if pendingDialog}
        <!-- Agent question: render the questions + options and return the answer -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="-mx-3 border-y border-green/40 bg-green-soft p-2" tabindex="-1" onkeydown={onDialogKey}>
          {#each dialogQuestions as question, questionIndex (questionIndex)}
            <div class="mb-3 last:mb-1">
              {#if question.header}
                <div class="mb-0.5 flex items-center gap-2 text-2xs font-semibold uppercase tracking-caps text-green">
                  <span>{question.header}</span>
                  {#if question.multiSelect}<span class="normal-case tracking-normal text-dim">· multi-select</span>{/if}
                </div>
              {/if}
              <div class="mb-1.5 text-xs text-default">{question.question}</div>
              <div class="flex flex-col gap-1">
                {#each question.options as option (option.label)}
                  {@const selected = (dialogSelections[questionIndex] || []).includes(option.label)}
                  <button
                    class="rounded-md border px-2 py-1.5 text-left text-xs {selected
                      ? 'border-green bg-green/15 text-default'
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

          {#if notesOpen}
            <textarea
              bind:this={notesEl}
              bind:value={dialogNotes}
              class="mb-2 h-16 w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs"
              placeholder="Notes / free-form answer…"
            ></textarea>
          {/if}

          <div class="flex items-center gap-2">
            <button
              class="rounded-md bg-action px-3 py-1 text-xs text-action-fg disabled:opacity-40"
              disabled={!dialogReady}
              onclick={submitDialog}
            >
              Answer
            </button>
            {#if !notesOpen}
              <button
                class="rounded-md border border-line px-3 py-1 text-xs text-dim hover:bg-hover"
                title="Add free-form notes"
                onclick={openNotes}
              >
                Notes (n)
              </button>
            {/if}
            <button
              class="ml-auto rounded-md border border-line px-3 py-1 text-xs text-dim hover:bg-hover"
              onclick={cancelDialog}
            >
              Cancel
            </button>
          </div>
        </div>
      {:else if pendingPermission}
        <!-- Permission prompt replaces the input until answered -->
        <div
          bind:this={permissionEl}
          class="rounded-md border border-amber/40 bg-amber-soft p-2 outline-none"
          tabindex="-1"
          onkeydown={onPermissionKey}
        >
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
              {#each permissionChoices as choice, index (choice.label)}
                <button
                  class="rounded-md px-3 py-1.5 text-left text-xs outline-none {choice.class} {index ===
                  permissionIndex
                    ? 'ring-2 ring-default'
                    : ''}"
                  onclick={choice.run}
                >
                  {choice.label}
                </button>
              {/each}
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
