<script lang="ts">
  import { settings } from '../../lib/settings.svelte'
  import { agentPrompt } from '../../lib/agentPrompt.svelte'
  import {
    store,
    refreshRuntimes,
    openFileInEditor,
    openFileAtLine,
    respondPermission,
    respondDialog,
    seedAgentTranscript,
    resetAgentChat,
    deleteAgentChat,
    refreshChats,
    renameChat,
    resumeChat,
    compactChat,
    ensureAgentModels
  } from '../../lib/store.svelte'
  import { parseQuestions } from '../../lib/agentDialog'
  import { inlineEdit } from '../../lib/inlineEdit.svelte'
  import { onMount, onDestroy } from 'svelte'
  import { keymap } from '../../lib/keymap.svelte'
  import type { LogLine } from '../../lib/store.svelte'
  import type { AgentRuntime, AgentConfig, ChatMeta, DiffFile } from '../../../../shared/types'
  import {
    parseAgentLines,
    parseAgentMeta,
    toolSummary,
    type OutputItem
  } from '../../lib/agentStream'
  import { buildSubagents } from '../../lib/agent/subagents'
  import { buildTaskList, taskResultKeys } from '../../lib/agent/tasks'
  import AgentTranscript from './AgentTranscript.svelte'
  import AgentQuestionDialog from './AgentQuestionDialog.svelte'
  import AgentPermissionPrompt from './AgentPermissionPrompt.svelte'
  import AgentTaskList from './AgentTaskList.svelte'
  import AgentSubagentList from './AgentSubagentList.svelte'
  import AgentWorkingBar from './AgentWorkingBar.svelte'
  import AgentQueue from './AgentQueue.svelte'
  import WaveSpinner from '../WaveSpinner.svelte'
  import AgentLogo from '../AgentLogo.svelte'
  import Kbd from '../Kbd.svelte'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'

  let { leafId }: { leafId: string } = $props()

  let prompt = $state('')
  let promptEl = $state<HTMLTextAreaElement>()
  // Whether the composer holds focus — drives the "press i to focus" hint shown
  // while in normal mode.
  let composerFocused = $state(false)

  // Keybind 'ai-prompt' actions prefill the composer and focus it.
  $effect(() => {
    if (agentPrompt.prefill === null) return
    const text = agentPrompt.consume()
    if (text === null) return
    prompt = text
    promptEl?.focus()
  })
  // The viewed tab's adapter (drives the transcript, tabs, permissions).
  let selectedAgent = $state<string>(settings.get<string>('workbench.defaultAgent') || '')
  // The selected instance (chat) of the selected adapter. Empty = fall back to
  // that adapter's active chat. Multiple instances of one adapter run at once.
  let selectedChatId = $state<string>('')
  // The adapter used for the NEXT run of this tab (the agent/model dropdown).
  // Defaults to the viewed tab's adapter; picking a different one converts the
  // tab on send. mode/model/effort are configured against this adapter.
  let launchAgent = $state<string>('')
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
  // Config/modes/models/efforts follow the launch adapter (what runs next).
  const config = $derived<AgentConfig | undefined>(store.agentConfigs[launchAgent])
  const modes = $derived(config?.modes || [])
  const efforts = $derived(config?.efforts || [])

  // Pick a default agent once configs load.
  $effect(() => {
    if (!selectedAgent && agentNames.length > 0) {
      const saved = settings.get<string>('workbench.defaultAgent') || ''
      selectedAgent = agentNames.includes(saved) ? saved : agentNames[0]
    }
  })

  // Honor a focus request from the agents overview: select that agent once the
  // pane is showing the same worktree, then clear the request.
  $effect(() => {
    const request = store.requestedAgent
    if (!request || request.worktreeId !== store.selectedWorktreeId) return
    if (agentNames.includes(request.name)) {
      selectedAgent = request.name
      selectedChatId = request.chatId || ''
    }
    store.requestedAgent = null
  })

  // Default the effort selection to 'high' for an adapter, falling back to the
  // first level when the adapter has no 'high'.
  function defaultEffortIndex(agent: string): number {
    const list = store.agentConfigs[agent]?.efforts || []
    const index = list.findIndex((effort) => effort.value === 'high')
    return index >= 0 ? index : 0
  }

  // When the viewed tab's adapter changes, default the launch config to it and
  // reset the per-agent selections (mode/model/effort differ per adapter).
  let lastAgent = ''
  $effect(() => {
    if (selectedAgent && selectedAgent !== lastAgent) {
      lastAgent = selectedAgent
      launchAgent = selectedAgent
      modeIndex = 0
      effortIndex = defaultEffortIndex(selectedAgent)
      selectedModel = ''
      agentNavActive = false
      focusedSubagentKey = null
      void settings.set('workbench.defaultAgent', selectedAgent, 'user')
    }
  })

  // Switch the launch provider (adapter). Resets the model + per-adapter config
  // when it actually changes, and lazily fetches that provider's models (which
  // populate its flyout submenu).
  function selectProvider(agent: string): void {
    if (agent !== launchAgent) {
      modeIndex = 0
      effortIndex = defaultEffortIndex(agent)
      selectedModel = ''
    }
    launchAgent = agent
    submenuProvider = agent
    void ensureAgentModels(agent)
  }

  // Hovering a provider row opens its model submenu.
  function openSubmenu(agent: string): void {
    submenuProvider = agent
    void ensureAgentModels(agent)
  }

  // Pick a concrete model from a provider's submenu — finalizes both.
  function pickProviderModel(agent: string, value: string): void {
    selectProvider(agent)
    selectedModel = value
    agentMenuOpen = false
    submenuProvider = null
    promptEl?.focus()
  }

  // Fetch the current provider's models on load so its label resolves.
  $effect(() => {
    void ensureAgentModels(launchAgent)
  })

  // ── Bottom-bar dropdowns (provider→model cascade, mode, effort) ─
  let agentMenuOpen = $state(false)
  // Which provider row's model submenu is currently open.
  let submenuProvider = $state<string | null>(null)
  let modeMenuOpen = $state(false)
  let effortMenuOpen = $state(false)

  function closeMenus(): void {
    agentMenuOpen = false
    submenuProvider = null
    modeMenuOpen = false
    effortMenuOpen = false
  }

  // Models offered by the launch adapter.
  const launchModels = $derived(store.agentModels[launchAgent] || [])

  // Label for the agent button. Falls back to the provider's default (first
  // listed) when the user hasn't explicitly picked one.
  const currentModelLabel = $derived.by(() => {
    const match = launchModels.find((model) => model.value === selectedModel)
    if (match) return match.label
    return launchModels[0]?.label || 'model'
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

  // Shift+Tab cycles the mode without opening the dropdown.
  function cycleMode(): void {
    if (modes.length === 0) return
    modeIndex = (modeIndex + 1) % modes.length
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
    // Small tag shown next to the label (e.g. 'agent' for discovered commands).
    badge?: string
    apply: () => void
  }

  let slashDismissed = $state(false)
  let slashIndex = $state(0)
  let slashListEl = $state<HTMLDivElement>()
  let mentionListEl = $state<HTMLDivElement>()

  // Keep the keyboard-highlighted menu row visible while arrowing through a
  // list longer than the menu's max height.
  function scrollMenuRowIntoView(viewport: HTMLDivElement | undefined, index: number): void {
    if (!viewport) return
    const row = viewport.querySelector(`[data-menu-index="${index}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }

  $effect(() => {
    scrollMenuRowIntoView(slashListEl, slashIndex)
  })

  $effect(() => {
    scrollMenuRowIntoView(mentionListEl, mentionIndex)
  })

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
      args: launchModels.map((model) => ({
        value: model.label,
        description: model.value,
        apply: () => (selectedModel = model.value)
      })),
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
      name: 'compact',
      description: 'Summarize & compact the conversation',
      args: [],
      // Enter runs it straight away; typing text after it steers the summary.
      run: () => compactCurrentChat(''),
      freeText: compactCurrentChat,
      freeTextHint: 'focus (optional)'
    })
    commands.push({
      name: 'rename',
      description: 'Name this chat',
      args: [],
      freeText: renameCurrentChat,
      freeTextHint: 'chat name'
    })
    commands.push({
      name: 'delete',
      description: 'Delete this chat',
      args: [],
      run: deleteCurrentChat
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
  // The effective instance: the explicitly-picked one, else the adapter's
  // active chat. Everything instance-scoped (transcript, queue, run) keys on it.
  const currentChatId = $derived(selectedChatId || currentChats?.activeId || '')
  // Per-instance queue key (matches the store's event:agent-queue bucketing).
  const queueKey = $derived(`${store.selectedWorktreeId}::${selectedAgent}::${currentChatId}`)

  // Keep the chat list current for /resume and /rename.
  $effect(() => {
    if (store.selectedWorktreeId && selectedAgent) {
      void refreshChats(store.selectedWorktreeId, selectedAgent)
    }
  })

  // ── Mid-run queue + discovered slash commands ──────────────────
  const queuedMessages = $derived(store.agentQueues[queueKey] || [])
  const discoveredCommands = $derived(store.agentCommands[chatsKey] || [])

  // Events only push changes; pull the current queue + command list when the
  // worktree/instance selection changes (e.g. after a pane reload).
  $effect(() => {
    const worktreeId = store.selectedWorktreeId
    const agent = selectedAgent
    const chatId = currentChatId
    if (!worktreeId || !agent || !chatId) return
    void window.workbench.agents.queue(worktreeId, agent, chatId).then((queue) => {
      store.agentQueues = { ...store.agentQueues, [`${worktreeId}::${agent}::${chatId}`]: queue }
    })
    void window.workbench.agents.commands(worktreeId, agent).then((commands) => {
      store.agentCommands = { ...store.agentCommands, [`${worktreeId}::${agent}`]: commands }
    })
  })

  // A user stop flushed queued messages — restore their text into the composer.
  $effect(() => {
    const restored = store.restoredQueueText[queueKey]
    if (!restored) return
    const { [queueKey]: _consumed, ...rest } = store.restoredQueueText
    store.restoredQueueText = rest
    prompt = prompt.trim() ? `${prompt}\n\n${restored}` : restored
  })

  function cancelQueued(id: string): void {
    if (!store.selectedWorktreeId || !currentChatId) return
    void window.workbench.agents.cancelQueued(
      store.selectedWorktreeId,
      selectedAgent,
      currentChatId,
      id
    )
  }

  // ── Stale-chat compact suggestion ──────────────────────────────
  // When reopening a chat that's been idle for a while, offer to compact it
  // rather than resuming a large stale context. Only a suggestion — compaction
  // never runs on its own, and fresh chats (no session yet) are never flagged.
  const STALE_CHAT_MS = 8 * 60 * 60 * 1000

  const activeChatMeta = $derived(
    currentChats?.chats.find((chat) => chat.id === currentChats.activeId) || null
  )

  // Chats the user already answered the suggestion for (compacted or dismissed).
  let compactSuggestionAnswered = $state<Set<string>>(new Set())

  function isStaleChat(chat: ChatMeta | null): boolean {
    // Needs a real session (something to compact) and a real timestamp; legacy
    // chats carry updatedAt 0, so skip them rather than treat them as ancient.
    if (!chat || !chat.session || chat.updatedAt === 0) return false
    return Date.now() - chat.updatedAt > STALE_CHAT_MS
  }

  const showCompactSuggestion = $derived(
    !!activeChatMeta &&
      isStaleChat(activeChatMeta) &&
      !compactSuggestionAnswered.has(activeChatMeta.id) &&
      !isRunning &&
      !pendingPermission &&
      !pendingDialog
  )

  function staleHoursLabel(chat: ChatMeta): string {
    const hours = Math.floor((Date.now() - chat.updatedAt) / (60 * 60 * 1000))
    if (hours < 24) return `${hours}h`
    return `${Math.floor(hours / 24)}d`
  }

  function answerCompactSuggestion(): void {
    if (!activeChatMeta) return
    compactSuggestionAnswered = new Set([...compactSuggestionAnswered, activeChatMeta.id])
  }

  function acceptCompactSuggestion(): void {
    answerCompactSuggestion()
    compactCurrentChat('')
  }

  function clearChat(): void {
    if (!store.selectedWorktreeId || !currentChatId) return
    void resetAgentChat(store.selectedWorktreeId, selectedAgent, currentChatId)
  }
  function compactCurrentChat(instructions: string): void {
    if (!store.selectedWorktreeId || !currentChatId) return
    // A compact turn is fresh output — re-pin the view to follow it.
    stuckToBottom = true
    void compactChat(
      store.selectedWorktreeId,
      selectedAgent,
      currentChatId,
      instructions.trim() || undefined
    )
  }
  async function renameCurrentChat(name: string): Promise<void> {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId || !currentChatId || !name.trim()) return
    await renameChat(worktreeId, selectedAgent, currentChatId, name.trim())
    await refreshChats(worktreeId, selectedAgent)
    // Tab labels come from the runtimes — reload so the new name shows.
    await refreshRuntimes(worktreeId)
  }
  async function deleteCurrentChat(): Promise<void> {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId || !currentChatId) return
    if (!confirm('Delete this chat? Its conversation and transcript are removed.')) return
    const agent = selectedAgent
    const chatId = currentChatId
    await deleteAgentChat(worktreeId, agent, chatId)
    replayed.delete(`${worktreeId}::${agent}::${chatId}`)
    await refreshChats(worktreeId, agent)
    // Switch to another instance, or fall back to the adapter's active chat.
    const next = (store.agents[worktreeId] || []).find(
      (instance) => !(instance.name === agent && instance.chatId === chatId)
    )
    if (next) selectInstance(next.name, next.chatId)
    else selectedChatId = ''
  }
  function resumeCurrentChat(chatId: string): void {
    if (!store.selectedWorktreeId) return
    void resumeChat(store.selectedWorktreeId, selectedAgent, chatId)
  }

  // Close a specific instance tab (its own delete button). Same teardown as
  // deleteCurrentChat, but targets the clicked instance rather than the viewed
  // one, and switches away only when the closed tab was the active one.
  async function closeInstance(name: string, chatId: string, event: MouseEvent): Promise<void> {
    event.stopPropagation()
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) return
    if (!confirm('Delete this chat? Its conversation and transcript are removed.')) return
    const wasActive = name === selectedAgent && chatId === currentChatId
    await deleteAgentChat(worktreeId, name, chatId)
    replayed.delete(`${worktreeId}::${name}::${chatId}`)
    await refreshChats(worktreeId, name)
    if (!wasActive) return
    // Switch to another instance, or fall back to the adapter's active chat.
    const next = (store.agents[worktreeId] || []).find(
      (instance) => !(instance.name === name && instance.chatId === chatId)
    )
    if (next) selectInstance(next.name, next.chatId)
    else selectedChatId = ''
  }

  function finishSlash(action: () => void): void {
    if (!slash) return
    action()
    prompt = prompt.slice(0, slash.start).replace(/\s+$/, '')
    promptEl?.focus()
  }

  // A discovered command stays in the prompt (unlike app commands): the agent
  // resolves it, so Enter submits `/name args` as-is.
  function insertDiscoveredCommand(name: string): void {
    if (!slash) return
    prompt = prompt.slice(0, slash.start) + `/${name} `
    promptEl?.focus()
  }

  const slashEntries = $derived.by<SlashEntry[]>(() => {
    if (!slash || slashDismissed) return []
    const rest = slash.rest
    const space = rest.indexOf(' ')

    // Command-selection phase: no argument typed yet.
    if (space === -1) {
      const query = rest.toLowerCase()
      const entries: SlashEntry[] = slashCommands
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
      // Provider-discovered commands after the built-ins (built-ins win name
      // collisions). Selecting one only inserts `/name ` — the full text is
      // submitted verbatim and resolved by the agent itself.
      const builtinNames = new Set(slashCommands.map((command) => command.name))
      for (const command of discoveredCommands) {
        if (builtinNames.has(command.name)) continue
        if (!command.name.toLowerCase().includes(query)) continue
        entries.push({
          label: `/${command.name}`,
          description: command.description || command.argumentHint || 'agent command',
          badge: 'agent',
          apply: () => insertDiscoveredCommand(command.name)
        })
      }
      return entries
    }

    // Argument phase: a command is chosen, filter its values.
    const commandName = rest.slice(0, space).toLowerCase()
    const argQuery = rest.slice(space + 1).toLowerCase()
    const command = slashCommands.find((entry) => entry.name === commandName)
    if (!command) return []
    const entries: SlashEntry[] = command.args
      .filter((arg) => arg.value.toLowerCase().includes(argQuery))
      .map((arg) => ({
        label: arg.value,
        description: arg.description,
        apply: () => finishSlash(arg.apply)
      }))

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

  // The "@token" being typed at the end of the prompt, if any. `raw` keeps the
  // original casing for path completion; `query` is the lowercase fuzzy needle.
  const mention = $derived.by(() => {
    const match = prompt.match(/(?:^|\s)@([^\s]*)$/)
    if (!match) return null
    const token = `@${match[1]}`
    return { start: prompt.length - token.length, raw: match[1], query: match[1].toLowerCase() }
  })

  // Tokens that look like paths (./ ../ / ~) switch from fuzzy matching over
  // the worktree file list to real directory completion, so any file on disk —
  // including one directory up via `@..` — can be mentioned.
  function parsePathMention(raw: string): { dir: string; base: string } | null {
    const looksLikePath = raw.startsWith('/') || raw.startsWith('~') || raw.startsWith('.')
    if (!looksLikePath) return null
    if (raw.endsWith('/')) return { dir: raw.slice(0, -1) || '/', base: '' }
    if (raw === '.' || raw === '..' || raw === '~') return { dir: raw, base: '' }
    const slash = raw.lastIndexOf('/')
    if (slash === -1) return { dir: '.', base: raw }
    return { dir: raw.slice(0, slash) || '/', base: raw.slice(slash + 1) }
  }

  const mentionPath = $derived(mention ? parsePathMention(mention.raw) : null)

  // Directory entries for the path being completed, fetched per directory.
  let mentionDirEntries = $state<{ name: string; isDir: boolean }[]>([])
  let mentionDirLoaded = $state<string | null>(null)

  $effect(() => {
    const worktreeId = store.selectedWorktreeId
    const dir = mentionPath?.dir
    if (!worktreeId || dir === undefined) return
    if (dir === mentionDirLoaded) return
    void window.workbench.files
      .listPath(worktreeId, dir)
      .then((entries) => {
        mentionDirEntries = entries.map((node) => ({ name: node.name, isDir: node.isDir }))
        mentionDirLoaded = dir
      })
      .catch(() => {
        mentionDirEntries = []
        mentionDirLoaded = dir
      })
  })

  const mentionItems = $derived.by<string[]>(() => {
    if (!mention || mentionDismissed) return []
    if (mentionPath) {
      if (mentionDirLoaded !== mentionPath.dir) return []
      const base = mentionPath.base.toLowerCase()
      const prefix = mentionPath.dir === '/' ? '' : mentionPath.dir
      return mentionDirEntries
        .filter((node) => node.name.toLowerCase().startsWith(base))
        .slice(0, 50)
        .map((node) => `${prefix}/${node.name}${node.isDir ? '/' : ''}`)
    }
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
    // A directory keeps the token open (no trailing space) so completion
    // continues into it; a file finishes the mention.
    const suffix = path.endsWith('/') ? '' : ' '
    prompt = `${prompt.slice(0, mention.start)}@${path}${suffix}`
    promptEl?.focus()
  }

  // ── Attachments (paste image / drop file into the composer) ────
  // The inserted @relpath text is the single source of truth: editable and
  // deletable like any mention, no parallel chip state to reconcile.
  function insertMentionAtCaret(relPath: string): void {
    const caret = promptEl ? promptEl.selectionStart : prompt.length
    const mentionText = `@${relPath} `
    prompt = prompt.slice(0, caret) + mentionText + prompt.slice(caret)
    queueMicrotask(() => {
      if (!promptEl) return
      const position = caret + mentionText.length
      promptEl.setSelectionRange(position, position)
      promptEl.focus()
    })
  }

  // An @file:lines reference pushed from the editor selection (inline edit,
  // Phase A). Nonce-gated so the same reference can be sent twice in a row.
  let lastComposerInsertNonce = 0
  $effect(() => {
    const request = store.composerInsert
    if (!request || request.nonce === lastComposerInsertNonce) return
    lastComposerInsertNonce = request.nonce
    insertMentionAtCaret(request.text)
  })

  function attachmentExtension(file: File): string {
    const fromName = file.name.split('.').pop()
    if (fromName && fromName !== file.name) return fromName.toLowerCase()
    const fromMime = file.type.split('/').pop()
    return fromMime || 'png'
  }

  async function attachFile(file: File): Promise<void> {
    if (!store.selectedWorktreeId) return
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      const saved = await window.workbench.files.saveAttachment(
        store.selectedWorktreeId,
        data,
        attachmentExtension(file)
      )
      insertMentionAtCaret(saved.relPath)
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  function onPromptPaste(event: ClipboardEvent): void {
    const images = Array.from(event.clipboardData?.files || []).filter((file) =>
      file.type.startsWith('image/')
    )
    // Plain-text pastes fall through untouched.
    if (images.length === 0) return
    event.preventDefault()
    for (const image of images) void attachFile(image)
  }

  function onPromptDrop(event: DragEvent): void {
    const files = Array.from(event.dataTransfer?.files || [])
    if (files.length === 0) return
    event.preventDefault()
    for (const file of files) {
      // Files already inside the worktree are mentioned in place; anything
      // external is copied into .workbench/attachments first.
      const absPath = window.workbench.files.pathForFile(file)
      const relPath = absPath ? relativeToWorktree(absPath) : null
      if (relPath) {
        insertMentionAtCaret(relPath)
        continue
      }
      void attachFile(file)
    }
  }

  function baseName(path: string): string {
    // Directory completions carry a trailing slash — keep it in the display.
    const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
    const name = trimmed.split('/').pop() || trimmed
    if (path.endsWith('/')) return `${name}/`
    return name
  }

  function onPromptKey(event: KeyboardEvent): void {
    // Ctrl+C interrupts the running agent — but only with a collapsed caret,
    // so copying selected text keeps working.
    if (event.key === 'c' && event.ctrlKey && !event.altKey && !event.metaKey && isRunning) {
      const target = event.currentTarget as HTMLTextAreaElement
      if (target.selectionStart === target.selectionEnd) {
        event.preventDefault()
        void stop()
        return
      }
    }
    // Alt+H / Alt+L step through the instance tabs, like editor buffer tabs.
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const key = event.key.toLowerCase()
      if (key === 'h' || key === 'l') {
        event.preventDefault()
        cycleInstance(key === 'l' ? 1 : -1)
        return
      }
    }
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
    // keys navigate the list (row 0 = the main chat) and Enter opens the
    // selected transcript. Entering the list lands on the currently viewed
    // agent; ArrowUp walks up the rows and only exits at the top.
    if (subagents.length > 0 && prompt.length === 0) {
      const rowCount = subagents.length + 1
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (!agentNavActive) {
          agentNavActive = true
          agentIndex = activeAgentRow()
        } else {
          agentIndex = Math.min(agentIndex + 1, rowCount - 1)
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
        if (agentIndex === 0) {
          focusedSubagentKey = null
          agentNavActive = false
        } else {
          focusSubagent(subagents[agentIndex - 1].key)
        }
        return
      }
      if (agentNavActive && event.key === 'Escape') {
        event.preventDefault()
        agentNavActive = false
        return
      }
    }
    // Escape leaves insert mode: blur the composer and hand the keyboard back to
    // the pane so normal-mode Vim bindings (jk scroll, alt+h/l) take over.
    if (event.key === 'Escape') {
      event.preventDefault()
      enterNormal()
      return
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
    agents.some(
      (agent) =>
        agent.name === selectedAgent && agent.chatId === currentChatId && agent.status === 'running'
    )
  )

  // Only this instance's lines: several instances can run in one worktree, and
  // their transcripts must not interleave in the pane.
  const agentLines = $derived<LogLine[]>(
    (store.selectedWorktreeId ? store.logs[store.selectedWorktreeId] || [] : []).filter(
      (line) =>
        line.source === 'agent' && line.name === selectedAgent && line.chatId === currentChatId
    )
  )
  const rawLines = $derived(agentLines.map((line) => line.line))
  const items = $derived(parseAgentLines(rawLines))
  const meta = $derived(parseAgentMeta(rawLines))

  // ── Subagents + task list (derived from the main stream) ───────
  const subagents = $derived(buildSubagents(items))
  const taskList = $derived(buildTaskList(items))
  let tasksOpen = $state(true)
  // Task tool-results are folded into the checklist; hide their raw rows.
  const taskResultKeySet = $derived(taskResultKeys(items))

  let agentNavActive = $state(false)
  // Row in the agents list: 0 is the main chat, 1..n are the subagents.
  let agentIndex = $state(0)
  let focusedSubagentKey = $state<string | null>(null)

  // The row of the transcript currently being viewed — where keyboard
  // navigation enters the list.
  function activeAgentRow(): number {
    if (!focusedSubagentKey) return 0
    const index = subagents.findIndex((agent) => agent.key === focusedSubagentKey)
    if (index === -1) return 0
    return index + 1
  }

  $effect(() => {
    if (agentIndex > subagents.length) agentIndex = subagents.length
  })

  // The transcript shows all items, or just one subagent's Task card + result
  // when a subagent is focused from the list.
  const visibleItems = $derived.by(() => {
    if (focusedSubagentKey) {
      const resultKey = `result:${focusedSubagentKey}`
      return items.filter((item) => item.key === focusedSubagentKey || item.key === resultKey)
    }
    // After a /compact, hide the summarized history and keep the boundary marker
    // as the new top of the conversation (like Claude Code's compact view).
    const lastCompact = items.findLastIndex((item) => item.kind === 'compact')
    const base = lastCompact > 0 ? items.slice(lastCompact) : items
    return base.filter((item) => !(item.kind === 'tool-result' && taskResultKeySet.has(item.key)))
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

  // ── Vim-style pane modes ───────────────────────────────────────
  // 'insert' focuses the composer; 'normal' scrolls the transcript and
  // navigates instances. The textarea's own focus/blur keep the mode honest
  // when the user clicks in and out.
  function enterInsert(): void {
    keymap.setPaneMode(leafId, 'insert')
    promptEl?.focus()
  }

  function enterNormal(): void {
    keymap.setPaneMode(leafId, 'normal')
    promptEl?.blur()
    keymap.focusPane(leafId)
  }

  function scrollTranscript(delta: number): void {
    const viewport = transcriptViewport
    if (!viewport) return
    stuckToBottom = false
    viewport.scrollTop += delta
  }

  function scrollTranscriptPage(fraction: number): void {
    if (!transcriptViewport) return
    scrollTranscript(transcriptViewport.clientHeight * fraction)
  }

  // ── Composer syntax highlight ──────────────────────────────────
  // A textarea can't color parts of its text, so an overlay behind the
  // (transparent-text) textarea renders the same string with /commands and
  // @mentions tinted. Tokens are recognized at a word boundary, anywhere in the
  // text — not just the one being typed at the caret.
  interface HighlightSegment {
    text: string
    kind: 'plain' | 'command' | 'mention'
  }

  let highlightEl = $state<HTMLDivElement>()

  const promptSegments = $derived.by<HighlightSegment[]>(() => {
    const segments: HighlightSegment[] = []
    const tokenPattern = /(?<=^|\s)([/@][^\s]*)/g
    let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = tokenPattern.exec(prompt)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ text: prompt.slice(lastIndex, match.index), kind: 'plain' })
      }
      const token = match[1]
      segments.push({ text: token, kind: token[0] === '/' ? 'command' : 'mention' })
      lastIndex = match.index + token.length
    }
    if (lastIndex < prompt.length) {
      segments.push({ text: prompt.slice(lastIndex), kind: 'plain' })
    }
    return segments
  })

  function segmentClass(kind: HighlightSegment['kind']): string {
    if (kind === 'command') return 'text-blue'
    if (kind === 'mention') return 'text-green'
    return ''
  }

  // Keep the overlay aligned with the textarea as it scrolls its own content.
  function syncHighlightScroll(): void {
    if (!highlightEl || !promptEl) return
    highlightEl.scrollTop = promptEl.scrollTop
    highlightEl.scrollLeft = promptEl.scrollLeft
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

  // ── Transcript find bar (Ctrl+F) ───────────────────────────────
  // Matches at item granularity: jumping scrolls the item into view with a
  // brief highlight ring (no text-level marks inside rendered markdown).
  let findOpen = $state(false)
  let findQuery = $state('')
  let findIndex = $state(0)
  let findInputEl = $state<HTMLInputElement>()
  let highlightedKey = $state<string | null>(null)
  let highlightTimer: ReturnType<typeof setTimeout> | undefined

  function itemSearchText(item: OutputItem): string {
    if (item.kind === 'tool') return `${item.tool} ${toolSummary(item.tool, item.input)}`
    if (item.kind === 'compact') return ''
    return item.text
  }

  const findMatches = $derived.by<string[]>(() => {
    const query = findQuery.trim().toLowerCase()
    if (!findOpen || !query) return []
    return visibleItems
      .filter((item) => itemSearchText(item).toLowerCase().includes(query))
      .map((item) => item.key)
  })

  // A changed query restarts at (and jumps to) the first match.
  $effect(() => {
    void findMatches
    findIndex = 0
    if (findMatches.length > 0) jumpToMatch(0)
  })

  // Manual scrollTop instead of scrollIntoView: the FloatingScrollbar viewport
  // is the scroll container, and scrollIntoView can also scroll ancestors.
  function jumpToMatch(index: number): void {
    const key = findMatches[index]
    const viewport = transcriptViewport
    if (!key || !viewport) return
    // Searching disengages follow-mode so streamed output doesn't yank the view.
    stuckToBottom = false
    const node = viewport.querySelector(`[data-item-key="${CSS.escape(key)}"]`)
    if (!(node instanceof HTMLElement)) return
    const nodeTop =
      node.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
    viewport.scrollTop = Math.max(0, nodeTop - viewport.clientHeight / 3)
    highlightedKey = key
    clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => (highlightedKey = null), 1200)
  }

  function stepMatch(direction: 1 | -1): void {
    if (findMatches.length === 0) return
    findIndex = (findIndex + direction + findMatches.length) % findMatches.length
    jumpToMatch(findIndex)
  }

  function openFind(): void {
    findOpen = true
    queueMicrotask(() => findInputEl?.select())
  }

  function closeFind(): void {
    findOpen = false
    findQuery = ''
    highlightedKey = null
    promptEl?.focus()
  }

  function onFindKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      stepMatch(event.shiftKey ? -1 : 1)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeFind()
    }
  }

  let disposeBindings: (() => void) | null = null
  onMount(() => {
    disposeBindings = keymap.registerBindings([
      {
        id: 'agent.findTranscript',
        keys: 'ctrl+f',
        context: 'agent',
        group: 'Agent',
        description: 'Find in transcript',
        run: openFind
      },
      // Normal-mode Vim bindings, scoped to this pane's leaf. They only fire
      // while the composer is unfocused (the keymap's typing gate) and the pane
      // reports 'normal'.
      {
        id: `agent.insert:${leafId}`,
        keys: 'i',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Insert mode (focus composer)',
        run: enterInsert
      },
      {
        id: `agent.scrollDown:${leafId}`,
        keys: 'j',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Scroll transcript down',
        run: () => scrollTranscript(60)
      },
      {
        id: `agent.scrollUp:${leafId}`,
        keys: 'k',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Scroll transcript up',
        run: () => scrollTranscript(-60)
      },
      {
        id: `agent.halfDown:${leafId}`,
        keys: 'ctrl+d',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Scroll half page down',
        run: () => scrollTranscriptPage(0.5)
      },
      {
        id: `agent.halfUp:${leafId}`,
        keys: 'ctrl+u',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Scroll half page up',
        run: () => scrollTranscriptPage(-0.5)
      },
      {
        id: `agent.pageDown:${leafId}`,
        keys: 'pagedown',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Scroll page down',
        run: () => scrollTranscriptPage(0.9)
      },
      {
        id: `agent.pageUp:${leafId}`,
        keys: 'pageup',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Scroll page up',
        run: () => scrollTranscriptPage(-0.9)
      },
      {
        id: `agent.prevInstance:${leafId}`,
        keys: 'alt+h',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Previous instance',
        run: () => cycleInstance(-1)
      },
      {
        id: `agent.nextInstance:${leafId}`,
        keys: 'alt+l',
        context: leafId,
        mode: 'normal',
        group: 'Agent',
        description: 'Next instance',
        run: () => cycleInstance(1)
      }
    ])
  })
  onDestroy(() => {
    disposeBindings?.()
    clearTimeout(highlightTimer)
  })

  // ── Working-state indicator ────────────────────────────────────
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
    const worktreeId = store.selectedWorktreeId
    try {
      if (isRunning) {
        // A run is active: inject the message live (or queue it) instead of
        // tearing the run down. Provider can't change mid-run.
        const text = prompt.trim()
        if (!text) return
        await window.workbench.agents.send(
          worktreeId,
          selectedAgent,
          text,
          currentChatId || undefined
        )
      } else {
        // If the user picked a different provider for this tab, convert it first
        // (fresh session, kept title), then run under the new adapter.
        if (launchAgent && launchAgent !== selectedAgent && currentChatId) {
          const moved = await window.workbench.agents.convertInstance(
            worktreeId,
            selectedAgent,
            launchAgent,
            currentChatId
          )
          if (moved) selectedAgent = launchAgent
        }
        const runtime = await window.workbench.agents.start(
          worktreeId,
          launchAgent || selectedAgent,
          launchOptions(),
          currentChatId || undefined
        )
        // Pin to the instance that was just started (fresh chat gets a new id).
        selectedAgent = runtime.name
        selectedChatId = runtime.chatId
        await refreshRuntimes(worktreeId)
      }
      // Sending a new prompt re-pins the view to the newest output.
      stuckToBottom = true
      pushHistory(prompt)
      prompt = ''
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  async function stop(): Promise<void> {
    if (!store.selectedWorktreeId || !selectedAgent || !currentChatId) return
    await window.workbench.agents.stop(store.selectedWorktreeId, selectedAgent, currentChatId)
    await refreshRuntimes(store.selectedWorktreeId)
  }

  // Spawn a fresh idle instance of the selected adapter and switch to it.
  async function spawnInstance(): Promise<void> {
    if (!store.selectedWorktreeId || !selectedAgent) return
    const chat = await window.workbench.agents.createInstance(
      store.selectedWorktreeId,
      selectedAgent
    )
    selectedChatId = chat.id
    await refreshChats(store.selectedWorktreeId, selectedAgent)
    await refreshRuntimes(store.selectedWorktreeId)
    promptEl?.focus()
  }

  // Switch the pane to a specific instance (adapter + chat).
  function selectInstance(name: string, chatId: string): void {
    selectedAgent = name
    selectedChatId = chatId
  }

  // Alt+H / Alt+L step through the instance tabs, like editor buffer tabs.
  function cycleInstance(delta: number): void {
    if (agents.length === 0) return
    const index = agents.findIndex(
      (instance) => instance.name === selectedAgent && instance.chatId === currentChatId
    )
    const base = index === -1 ? 0 : index
    const next = agents[(base + delta + agents.length) % agents.length]
    if (next) selectInstance(next.name, next.chatId)
  }

  // ── Transcript replay + New chat ───────────────────────────────
  // Restore an instance after a restart: when it has no in-memory history yet,
  // load its persisted transcript from disk once.
  const replayed = new Set<string>()
  $effect(() => {
    const worktreeId = store.selectedWorktreeId
    const agent = selectedAgent
    const chatId = currentChatId
    if (!worktreeId || !agent || !chatId) return
    const replayKey = `${worktreeId}::${agent}::${chatId}`
    if (replayed.has(replayKey)) return
    const hasLines = (store.logs[worktreeId] || []).some(
      (line) => line.source === 'agent' && line.name === agent && line.chatId === chatId
    )
    replayed.add(replayKey)
    if (hasLines) return
    void window.workbench.agents
      .transcript(worktreeId, agent, chatId)
      .then((lines) => seedAgentTranscript(worktreeId, agent, chatId, lines))
      .catch(() => {})
  })

  // ── Interactive permission prompt ──────────────────────────────
  const pendingPermission = $derived(
    store.pendingPermissions.find(
      (request) =>
        request.worktreeId === store.selectedWorktreeId &&
        request.agent === selectedAgent &&
        request.chatId === currentChatId
    ) || null
  )
  function approve(remember: boolean): void {
    if (!pendingPermission) return
    // Close the editor preview and reload the buffer once the write lands.
    void inlineEdit.approveGatedPreview()
    void respondPermission(pendingPermission.id, { behavior: 'allow', remember })
  }
  function deny(message: string): void {
    if (!pendingPermission) return
    void respondPermission(pendingPermission.id, {
      behavior: 'deny',
      message: message.trim() || 'Denied by user'
    })
  }
  function showChange(): void {
    // The proposed change is previewed as a vimdiff split in the editor; this
    // refocuses the file there.
    if (pendingPermission?.path && store.selectedWorktreeId) {
      openFileInEditor(store.selectedWorktreeId, pendingPermission.path)
    }
  }

  // ── Agent question dialog ──────────────────────────────────────
  const pendingDialog = $derived(
    store.pendingDialogs.find(
      (request) =>
        request.worktreeId === store.selectedWorktreeId &&
        request.agent === selectedAgent &&
        request.chatId === currentChatId
    ) || null
  )
  const dialogQuestions = $derived(pendingDialog ? parseQuestions(pendingDialog.payload) : [])

  function answerDialog(result: { answers: Record<string, string>; notes?: string }): void {
    if (!pendingDialog) return
    void respondDialog(pendingDialog.id, { behavior: 'completed', result })
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

  // Open a @file mention from a user message. A trailing :line(-range) reveals
  // that line; mentions are worktree-relative, so resolve against the root.
  function openMention(raw: string): void {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) return
    // Accept a trailing :line, :line-end range, or :line:col suffix.
    const lineMatch = raw.match(/:(\d+)(?:[:-]\d+)?$/)
    const path = raw.replace(/:(\d+)(?:[:-]\d+)?$/, '')
    const root = store.selectedWorktree?.path
    const target = path.startsWith('/') || !root ? path : `${root}/${path}`
    if (lineMatch) openFileAtLine(worktreeId, target, Number(lineMatch[1]))
    else openFileInEditor(worktreeId, target)
  }

  // Tool inputs carry absolute paths; the diff pane and fs watcher speak
  // worktree-relative ones.
  function relativeToWorktree(absPath: string): string | null {
    const root = store.selectedWorktree?.path
    if (!root) return null
    if (!absPath.startsWith(`${root}/`)) return null
    return absPath.slice(root.length + 1)
  }

  // Open a file-edit tool's target in the editor and review its uncommitted
  // hunks with the floating accept/reject overlay.
  function openCardDiff(input: Record<string, unknown>): void {
    const path = filePath(input)
    const worktreeId = store.selectedWorktreeId
    const root = store.selectedWorktree?.path
    if (!path || !worktreeId || !root) return
    const relPath = path.startsWith('/') ? relativeToWorktree(path) : path
    if (!relPath) return
    const file: DiffFile = { path: relPath, changeType: 'modified', staged: false }
    void inlineEdit.reviewWorkingTreeFile(worktreeId, file, `${root}/${relPath}`)
  }

  // Tool lines show a one-line summary; expand to see the full command / input.
  let expandedTools = $state<Record<string, boolean>>({})
  function toggleTool(key: string): void {
    expandedTools = { ...expandedTools, [key]: !expandedTools[key] }
  }

  // Tool results (e.g. a Read returning a whole file) are collapsed so the
  // output isn't flooded with file contents; click to expand.
  let expandedResults = $state<Record<string, boolean>>({})
  function toggleResult(key: string): void {
    expandedResults = { ...expandedResults, [key]: !expandedResults[key] }
  }

  // Consecutive file edits collapse into one "edited N files" group.
  let expandedGroups = $state<Record<string, boolean>>({})
  function toggleGroup(key: string): void {
    expandedGroups = { ...expandedGroups, [key]: !expandedGroups[key] }
  }
</script>

<div class="flex h-full flex-col">
  {#if !store.selectedWorktreeId}
    <p class="px-3 py-3 text-xs text-dim">Select a worktree.</p>
  {:else}
    <!-- Instance switcher (Alt+H/L to step): one tab per instance, plus spawn.
         Each tab shows the adapter logo and the chat title. -->
    <div
      class="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 py-1"
    >
      {#each agents as instance (instance.name + '::' + instance.chatId)}
        {@const active = instance.name === selectedAgent && instance.chatId === currentChatId}
        <div
          class="group/tab flex shrink-0 items-center rounded px-2 py-1 text-xs {active
            ? 'bg-raised text-default'
            : 'text-dim hover:bg-hover hover:text-default'}"
          title="{instance.name} · {instance.label} ({instance.status})"
        >
          <button
            class="flex cursor-pointer items-center gap-1.5"
            onclick={() => selectInstance(instance.name, instance.chatId)}
          >
            <AgentLogo name={instance.name} size={15} {active} />
            <span class="max-w-[12rem] truncate">{instance.label}</span>
            {#if instance.status === 'running'}
              <span class="text-green"><WaveSpinner count={3} /></span>
            {/if}
          </button>
          <button
            class="inline-flex w-0 shrink-0 cursor-pointer items-center overflow-hidden text-dim opacity-0 transition-all duration-150 ease-out hover:text-red group-hover/tab:ml-1 group-hover/tab:w-3.5 group-hover/tab:opacity-100"
            title="Close chat"
            onclick={(event) => closeInstance(instance.name, instance.chatId, event)}>✕</button
          >
        </div>
      {/each}
      <button
        class="shrink-0 rounded px-2 py-1 text-2xs text-dim hover:bg-hover hover:text-default"
        title="New instance of {selectedAgent || 'the selected adapter'}"
        disabled={!selectedAgent}
        onclick={spawnInstance}
      >
        ＋
      </button>
    </div>

    {#if findOpen}
      <!-- Transcript find bar (Ctrl+F): pinned below the pane header. -->
      <div class="flex shrink-0 items-center gap-2 border-b border-line bg-elevated px-3 py-1.5">
        <input
          bind:this={findInputEl}
          bind:value={findQuery}
          onkeydown={onFindKey}
          class="min-w-0 flex-1 rounded border border-line bg-input px-2 py-0.5 text-xs"
          placeholder="Find in transcript…"
        />
        <span class="shrink-0 font-mono text-2xs text-dim">
          {findMatches.length === 0 ? '0/0' : `${findIndex + 1}/${findMatches.length}`}
        </span>
        <button
          class="shrink-0 text-2xs text-dim hover:text-default"
          title="Previous match (Shift+Enter)"
          onclick={() => stepMatch(-1)}>↑</button
        >
        <button
          class="shrink-0 text-2xs text-dim hover:text-default"
          title="Next match (Enter)"
          onclick={() => stepMatch(1)}>↓</button
        >
        <button
          class="shrink-0 text-2xs text-dim hover:text-default"
          title="Close (Esc)"
          onclick={closeFind}>✕</button
        >
      </div>
    {/if}
    <!-- Chat transcript -->
    <AgentTranscript
      {items}
      {visibleItems}
      {highlightedKey}
      {expandedTools}
      {expandedResults}
      {expandedGroups}
      {toggleTool}
      {toggleResult}
      {toggleGroup}
      {filePath}
      relativePath={relativeToWorktree}
      {openCard}
      {openCardDiff}
      {openMention}
      bind:viewport={transcriptViewport}
      onscroll={onTranscriptScroll}
    />

    {#if isRunning}
      <AgentWorkingBar message={funnyMessage} tokensLabel={formatTokens(meta.totalTokens)} />
    {/if}

    {#if queuedMessages.length > 0}
      <AgentQueue messages={queuedMessages} onCancel={cancelQueued} />
    {/if}

    {#if taskList.length > 0}
      <AgentTaskList tasks={taskList} bind:open={tasksOpen} />
    {/if}

    <!-- Input + config status line pinned at the bottom -->
    <div class="relative shrink-0 border-t border-line p-3">
      {#if pendingDialog}
        <!-- Agent question: render the questions + options and return the answer.
             Keyed so per-dialog selection state resets for each new request. -->
        {#key pendingDialog.id}
          <AgentQuestionDialog
            questions={dialogQuestions}
            onAnswer={answerDialog}
            onCancel={cancelDialog}
          />
        {/key}
      {:else if pendingPermission}
        <!-- Permission prompt replaces the input until answered. Keyed so
             highlight/deny-reason state resets for each new request. -->
        {#key pendingPermission.id}
          <AgentPermissionPrompt
            title={pendingPermission.title}
            path={pendingPermission.path}
            hasDiff={store.proposedDiff !== null}
            onApprove={approve}
            onDeny={deny}
            onShowChange={showChange}
          />
        {/key}
      {:else}
        {#if showCompactSuggestion && activeChatMeta}
          <!-- Idle chat: offer to compact before resuming a stale context. -->
          <div
            class="mb-2 flex items-center gap-2 rounded-md border border-violet/30 bg-violet-soft px-2 py-1.5 text-2xs text-violet"
          >
            <span class="min-w-0 flex-1 truncate">
              This chat has been idle for {staleHoursLabel(activeChatMeta)}. Compact it?
            </span>
            <button
              class="shrink-0 rounded bg-violet px-2 py-0.5 text-action-fg"
              onclick={acceptCompactSuggestion}
            >
              Compact
            </button>
            <button
              class="shrink-0 rounded border border-line px-2 py-0.5 text-dim hover:bg-hover"
              onclick={answerCompactSuggestion}
            >
              Dismiss
            </button>
          </div>
        {/if}

        {#if slashOpen}
          <!-- Slash menu floats above the input -->
          <div
            class="absolute bottom-full left-3 right-3 z-20 mb-1 overflow-hidden rounded-md border border-line bg-elevated shadow-lg"
          >
            <FloatingScrollbar class="max-h-56" bind:viewport={slashListEl}>
              {#each slashEntries as entry, index (entry.label)}
                <button
                  data-menu-index={index}
                  class="flex w-full items-center gap-3 px-2 py-1.5 text-left text-xs {index ===
                  slashIndex
                    ? 'bg-action text-action-fg'
                    : 'text-muted hover:bg-hover'}"
                  onmousedown={(event) => {
                    event.preventDefault()
                    entry.apply()
                  }}
                >
                  <span class="font-mono font-medium">{entry.label}</span>
                  {#if entry.badge}
                    <span class="rounded bg-violet/15 px-1 font-mono text-2xs text-violet"
                      >{entry.badge}</span
                    >
                  {/if}
                  {#if entry.description}
                    <span
                      class="ml-auto truncate font-mono text-2xs {index === slashIndex
                        ? 'text-action-fg/70'
                        : 'text-dim'}">{entry.description}</span
                    >
                  {/if}
                </button>
              {/each}
            </FloatingScrollbar>
          </div>
        {/if}

        {#if mentionOpen}
          <!-- File-mention menu floats above the input -->
          <div
            class="absolute bottom-full left-3 right-3 z-20 mb-1 overflow-hidden rounded-md border border-line bg-elevated shadow-lg"
          >
            <FloatingScrollbar class="max-h-56" bind:viewport={mentionListEl}>
              {#each mentionItems as file, index (file)}
                <button
                  data-menu-index={index}
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
            </FloatingScrollbar>
          </div>
        {/if}

        <!-- Composer: a transparent-text textarea over a highlight overlay that
             tints /commands and @mentions. Both share the same box metrics so
             the rendered text lines up exactly. -->
        <div class="relative mb-2 rounded-md border border-line bg-input">
          <div
            bind:this={highlightEl}
            aria-hidden="true"
            class="pointer-events-none absolute inset-0 h-20 overflow-hidden whitespace-pre-wrap break-words px-2 py-1.5 text-xs text-default"
          >{#each promptSegments as segment, index (index)}<span class={segmentClass(segment.kind)}
              >{segment.text}</span
            >{/each}</div>
          <textarea
            bind:this={promptEl}
            class="relative h-20 w-full resize-none border-0 bg-transparent px-2 py-1.5 text-xs text-transparent caret-[var(--text)] outline-none placeholder:text-dim"
            placeholder={isRunning
              ? 'Message the running agent…  ( Enter send · Ctrl+C stop )'
              : 'Prompt…  ( / options · @ files · ↑↓ history · Shift+Tab mode · Enter run )'}
            bind:value={prompt}
            onkeydown={onPromptKey}
            oninput={() => (historyIndex = -1)}
            onscroll={syncHighlightScroll}
            onfocus={() => {
              composerFocused = true
              keymap.setPaneMode(leafId, 'insert')
            }}
            onblur={() => {
              composerFocused = false
              keymap.setPaneMode(leafId, 'normal')
            }}
            onpaste={onPromptPaste}
            ondrop={onPromptDrop}
            ondragover={(event) => event.preventDefault()}
          ></textarea>

          {#if !composerFocused}
            <!-- Normal-mode hint: press i (or click) to focus the composer. -->
            <button
              class="absolute right-2 top-2 flex items-center gap-1.5 rounded-full border border-line bg-raised px-2 py-0.5 text-2xs text-dim transition hover:text-default"
              title="Focus composer"
              onclick={enterInsert}
            >
              <Kbd>i</Kbd>
              <span>to focus</span>
            </button>
          {/if}
        </div>

        <div class="relative flex items-center gap-2 text-2xs">
          <!-- Backdrop closes any open menu on outside click. -->
          {#if agentMenuOpen || modeMenuOpen || effortMenuOpen}
            <button
              class="fixed inset-0 z-10 cursor-default"
              tabindex="-1"
              aria-label="Close menu"
              onclick={closeMenus}
            ></button>
          {/if}

          <!-- Provider → model cascade: one button; each provider row flies out
               a submenu of that provider's models. -->
          <div class="relative z-20">
            <button
              class="flex items-center gap-1.5 rounded border border-line px-2 py-1 hover:bg-hover"
              title="Provider & model for the next run"
              onclick={() => {
                modeMenuOpen = false
                effortMenuOpen = false
                agentMenuOpen = !agentMenuOpen
                if (!agentMenuOpen) submenuProvider = null
              }}
            >
              <AgentLogo name={launchAgent} size={14} />
              <span class="font-medium text-default">{launchAgent}</span>
              <span class="text-dim">·</span>
              <span class="text-muted">{currentModelLabel}</span>
              <span class="text-dim">▾</span>
            </button>
            {#if agentMenuOpen}
              <div
                class="absolute bottom-full left-0 z-30 mb-1 w-44 rounded-md border border-line bg-elevated py-1 shadow-lg"
              >
                {#each agentNames as name (name)}
                  {@const models = store.agentModels[name] || []}
                  <div class="relative" role="presentation" onmouseenter={() => openSubmenu(name)}>
                    <button
                      class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-hover {name ===
                      launchAgent
                        ? 'text-default'
                        : 'text-dim'}"
                      onclick={() => selectProvider(name)}
                    >
                      <AgentLogo name={name} size={13} />
                      <span class="truncate">{name}</span>
                      <span class="ml-auto text-dim">›</span>
                    </button>
                    {#if submenuProvider === name}
                      <!-- Model submenu, flown out to the right of the row. -->
                      <div
                        class="absolute bottom-0 left-full z-40 ml-1 w-56 overflow-hidden rounded-md border border-line bg-elevated shadow-lg"
                      >
                        <FloatingScrollbar class="max-h-72">
                          <div class="py-1">
                            {#each models as model (model.value)}
                              <button
                                class="flex w-full items-center px-2 py-1 text-left hover:bg-hover {name ===
                                  launchAgent && model.value === selectedModel
                                  ? 'text-default'
                                  : 'text-dim'}"
                                onclick={() => pickProviderModel(name, model.value)}
                              >
                                <span class="truncate">{model.label}</span>
                              </button>
                            {/each}
                            {#if models.length === 0}
                              <div class="px-2 py-1 text-2xs text-dim">
                                No models — type <span class="font-mono">/model</span>
                              </div>
                            {/if}
                          </div>
                        </FloatingScrollbar>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Mode -->
          {#if modes.length > 0}
            <div class="relative z-20">
              <button
                class="flex items-center gap-1 rounded border border-line px-2 py-1 hover:bg-hover"
                title="Mode"
                onclick={() => {
                  agentMenuOpen = false
                  effortMenuOpen = false
                  modeMenuOpen = !modeMenuOpen
                }}
              >
                <span class="font-medium {modeColor(modeLabel)}">{modeLabel}</span>
                <span class="text-dim">▾</span>
              </button>
              {#if modeMenuOpen}
                <div
                  class="absolute bottom-full left-0 z-30 mb-1 w-44 overflow-auto rounded-md border border-line bg-elevated py-1 shadow-lg"
                >
                  {#each modes as mode, index (mode.value)}
                    <button
                      class="flex w-full items-center px-2 py-1 text-left hover:bg-hover {index ===
                      modeIndex
                        ? 'text-default'
                        : 'text-dim'}"
                      onclick={() => {
                        modeIndex = index
                        closeMenus()
                      }}
                    >
                      <span class={modeColor(mode.label)}>{mode.label}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

          <!-- Effort -->
          {#if efforts.length > 0}
            <div class="relative z-20 ml-auto">
              <button
                class="flex items-center gap-1 rounded border border-line px-2 py-1 hover:bg-hover"
                title="Effort"
                onclick={() => {
                  agentMenuOpen = false
                  modeMenuOpen = false
                  effortMenuOpen = !effortMenuOpen
                }}
              >
                <span class="font-medium text-default">{effortLabel}</span>
                <span class="text-dim">▾</span>
              </button>
              {#if effortMenuOpen}
                <div
                  class="absolute bottom-full right-0 z-30 mb-1 w-40 overflow-auto rounded-md border border-line bg-elevated py-1 shadow-lg"
                >
                  {#each efforts as effort, index (effort.value)}
                    <button
                      class="flex w-full items-center px-2 py-1 text-left hover:bg-hover {index ===
                      effortIndex
                        ? 'text-default'
                        : 'text-dim'}"
                      onclick={() => {
                        effortIndex = index
                        closeMenus()
                      }}
                    >
                      {effort.label}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

          {#if isRunning}
            <button
              class="rounded-md border border-line px-3 py-1 text-xs hover:bg-hover {efforts.length >
              0
                ? ''
                : 'ml-auto'}"
              onclick={stop}
            >
              ■ Stop
            </button>
          {/if}
        </div>
      {/if}
    </div>

    {#if subagents.length > 0}
      <AgentSubagentList
        {subagents}
        {isRunning}
        focusedKey={focusedSubagentKey}
        navActive={agentNavActive}
        navIndex={agentIndex}
        onSelectMain={() => (focusedSubagentKey = null)}
        onSelect={focusSubagent}
      />
    {/if}
  {/if}
</div>
