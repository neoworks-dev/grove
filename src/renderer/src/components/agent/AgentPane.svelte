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
    refreshChats,
    renameChat,
    resumeChat,
    compactChat
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
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'

  let prompt = $state('')
  let promptEl = $state<HTMLTextAreaElement>()

  // Keybind 'ai-prompt' actions prefill the composer and focus it.
  $effect(() => {
    if (agentPrompt.prefill === null) return
    const text = agentPrompt.consume()
    if (text === null) return
    prompt = text
    promptEl?.focus()
  })
  let selectedAgent = $state<string>(settings.get<string>('workbench.defaultAgent') || '')
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
      const saved = settings.get<string>('workbench.defaultAgent') || ''
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
      void settings.set('workbench.defaultAgent', selectedAgent, 'user')
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

  // ── Mid-run queue + discovered slash commands ──────────────────
  const queuedMessages = $derived(store.agentQueues[chatsKey] || [])
  const discoveredCommands = $derived(store.agentCommands[chatsKey] || [])

  // Events only push changes; pull the current queue + command list when the
  // worktree/agent selection changes (e.g. after a pane reload).
  $effect(() => {
    const worktreeId = store.selectedWorktreeId
    const agent = selectedAgent
    if (!worktreeId || !agent) return
    const key = `${worktreeId}::${agent}`
    void window.workbench.agents.queue(worktreeId, agent).then((queue) => {
      store.agentQueues = { ...store.agentQueues, [key]: queue }
    })
    void window.workbench.agents.commands(worktreeId, agent).then((commands) => {
      store.agentCommands = { ...store.agentCommands, [key]: commands }
    })
  })

  // A user stop flushed queued messages — restore their text into the composer.
  $effect(() => {
    const restored = store.restoredQueueText[chatsKey]
    if (!restored) return
    const { [chatsKey]: _consumed, ...rest } = store.restoredQueueText
    store.restoredQueueText = rest
    prompt = prompt.trim() ? `${prompt}\n\n${restored}` : restored
  })

  function cancelQueued(id: string): void {
    if (!store.selectedWorktreeId) return
    void window.workbench.agents.cancelQueued(store.selectedWorktreeId, selectedAgent, id)
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
    if (!store.selectedWorktreeId) return
    void resetAgentChat(store.selectedWorktreeId, selectedAgent)
  }
  function compactCurrentChat(instructions: string): void {
    if (!store.selectedWorktreeId) return
    // A compact turn is fresh output — re-pin the view to follow it.
    stuckToBottom = true
    void compactChat(store.selectedWorktreeId, selectedAgent, instructions.trim() || undefined)
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

  // Only this agent's lines: several agents can run in one worktree, and their
  // transcripts must not interleave in the pane.
  const agentLines = $derived<LogLine[]>(
    (store.selectedWorktreeId ? store.logs[store.selectedWorktreeId] || [] : []).filter(
      (line) => line.source === 'agent' && line.name === selectedAgent
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

  let disposeFindBinding: (() => void) | null = null
  onMount(() => {
    disposeFindBinding = keymap.registerBindings([
      {
        id: 'agent.findTranscript',
        keys: 'ctrl+f',
        context: 'agent',
        group: 'Agent',
        description: 'Find in transcript',
        run: openFind
      }
    ])
  })
  onDestroy(() => {
    disposeFindBinding?.()
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
    try {
      if (isRunning) {
        // A run is active: inject the message live (or queue it) instead of
        // tearing the run down.
        const text = prompt.trim()
        if (!text) return
        await window.workbench.agents.send(store.selectedWorktreeId, selectedAgent, text)
      } else {
        await window.workbench.agents.start(
          store.selectedWorktreeId,
          selectedAgent,
          launchOptions()
        )
        await refreshRuntimes(store.selectedWorktreeId)
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
      (request) =>
        request.worktreeId === store.selectedWorktreeId && request.agent === selectedAgent
    ) || null
  )
  function approve(remember: boolean): void {
    if (!pendingPermission) return
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
    // The proposed change is rendered inline below; this opens the file on disk
    // in the editor for surrounding context.
    if (pendingPermission?.path && store.selectedWorktreeId) {
      openFileInEditor(store.selectedWorktreeId, pendingPermission.path)
    }
  }

  // Git-computed preview of a pending Write/Edit, rendered inline so review of a
  // gated change isn't blind (replaces the old dedicated diff pane).
  let proposedDiffText = $state('')
  $effect(() => {
    const proposed = store.proposedDiff
    const worktreeId = store.selectedWorktreeId
    if (!proposed || !worktreeId) {
      proposedDiffText = ''
      return
    }
    void window.workbench.git
      .diffText(worktreeId, proposed.original, proposed.modified)
      .then((text) => {
        proposedDiffText = text
      })
      .catch(() => {
        proposedDiffText = ''
      })
  })

  // Drop git's file headers/noise; keep the hunk headers and +/-/context lines.
  const proposedDiffLines = $derived.by(() => {
    if (!proposedDiffText) return []
    return proposedDiffText.split('\n').filter((line) => {
      if (line.startsWith('diff ') || line.startsWith('index ')) return false
      if (line.startsWith('--- ') || line.startsWith('+++ ')) return false
      if (line.startsWith('\\ No newline')) return false
      return line.length > 0
    })
  })

  // ── Agent question dialog ──────────────────────────────────────
  const pendingDialog = $derived(
    store.pendingDialogs.find(
      (request) =>
        request.worktreeId === store.selectedWorktreeId && request.agent === selectedAgent
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
            diffLines={proposedDiffLines}
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

        <textarea
          bind:this={promptEl}
          class="mb-2 h-20 w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs"
          placeholder={isRunning
            ? 'Message the running agent…  ( Enter send · Ctrl+C stop )'
            : 'Prompt…  ( / options · @ files · ↑↓ history · Shift+Tab mode · Enter run )'}
          bind:value={prompt}
          onkeydown={onPromptKey}
          oninput={() => (historyIndex = -1)}
          onpaste={onPromptPaste}
          ondrop={onPromptDrop}
          ondragover={(event) => event.preventDefault()}
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
