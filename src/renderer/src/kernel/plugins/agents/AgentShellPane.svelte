<script lang="ts">
  // The agent's terminal: the commands the session on screen runs — the
  // agent's and the user's `!` ones — each under its command line, with what it
  // printed streaming in, and the one running at the bottom taking the keyboard.
  //
  // Commands run one after another share the first tab. A command left running
  // in the background gets a tab of its own as soon as it goes there, so a dev
  // server printing away does not keep redrawing the commands after it; its tab
  // stays until it has exited and is closed.
  import { agentSessions } from '../../../lib/agents/sessions.svelte'
  import { catalog } from '../../../lib/agents/catalog.svelte'
  import { shellOutputs } from '../../../lib/agents/shellOutput.svelte'
  import { shellCommandsOf, type ShellCommand } from '../../../lib/agents/shellTranscript'
  import { warmLanguage } from '../../../lib/highlight'
  import { inputViewOf } from '../../../lib/agents/tools'
  import { visibleItems, type ToolItem } from '../../../lib/agents/transcript'
  import { store } from '../../../lib/store.svelte'
  import AgentTerminalView from './AgentTerminalView.svelte'

  let { leafId }: { leafId: string } = $props()

  const MAIN_TAB = 'agent'

  const worktreePath = $derived(store.selectedWorktree?.path ?? '')
  const sessionId = $derived(worktreePath ? agentSessions.resolveActive(worktreePath) : null)
  const meta = $derived(agentSessions.list.find((session) => session.id === sessionId))
  const live = $derived(sessionId ? agentSessions.live[sessionId] : undefined)

  // Which calls are commands is the harness's to say: its tools declare the
  // ones whose input is a command line. The Agent pane showing the session has
  // loaded them; until it has, a call with a command line counts.
  const shellToolNames = $derived.by(() => {
    const harness = meta?.harness
    if (!harness) return null
    const tools = catalog.byHarness[harness]?.tools
    if (!tools) return null
    return new Set(
      tools.filter((tool) => inputViewOf(tool.display) === 'command').map((tool) => tool.name)
    )
  })

  /** Whether a call ran a command line. */
  function isShellCall(item: ToolItem): boolean {
    if (shellToolNames) return shellToolNames.has(item.name)
    const input = item.input as { command?: unknown } | null
    return typeof input?.command === 'string'
  }

  const commands = $derived.by(() => {
    if (!live || !sessionId) return []
    const items = visibleItems(live.transcript)
    return shellCommandsOf(items, isShellCall, shellOutputs.forSession(sessionId))
  })

  // The background commands with a tab, in the order they went there, for the
  // session they belong to.
  let backgroundTabs = $state<string[]>([])
  let tabsSession: string | null = null
  let activeTab = $state(MAIN_TAB)
  let views = $state<Record<string, AgentTerminalView>>({})

  // A new session starts from its own commands; a command that goes to the
  // background gets its tab.
  $effect(() => {
    const session = sessionId
    const live = session ? shellOutputs.forSession(session) : {}
    if (session !== tabsSession) {
      tabsSession = session
      backgroundTabs = []
      activeTab = MAIN_TAB
    }
    for (const command of commands) {
      if (live[command.toolUseId]?.background && !backgroundTabs.includes(command.toolUseId)) {
        backgroundTabs = [...backgroundTabs, command.toolUseId]
      }
    }
  })

  const mainCommands = $derived(commands.filter((command) => !backgroundTabs.includes(command.toolUseId)))

  /** The command a background tab holds, while the transcript still has it. */
  function commandOf(id: string): ShellCommand | undefined {
    return commands.find((command) => command.toolUseId === id)
  }

  /** Where a command stands, for the dot on its tab. */
  function stateOf(command: ShellCommand | undefined): 'waiting' | 'running' | 'failed' | 'done' {
    if (!command || !sessionId) return 'done'
    if (shellOutputs.of(sessionId, command.toolUseId)?.waitingForInput) return 'waiting'
    if (command.running) return 'running'
    if (command.failure) return 'failed'
    return 'done'
  }

  const mainState = $derived(stateOf(mainCommands.findLast((command) => command.running)))

  // Where the shown tab's command stands, for the hint beside the tabs.
  const activeState = $derived.by(() => {
    if (activeTab === MAIN_TAB) return mainState
    return stateOf(commandOf(activeTab))
  })

  /** Shows a tab and gives it the keyboard. */
  function selectTab(id: string): void {
    activeTab = id
    requestAnimationFrame(() => views[id]?.focus())
  }

  /** Closes a background tab whose command has exited. */
  function closeTab(id: string): void {
    backgroundTabs = backgroundTabs.filter((tab) => tab !== id)
    if (activeTab === id) activeTab = MAIN_TAB
  }

  // Prompts are coloured as shell, the way a tool call's command is. The grammar
  // loads once; nothing is written until it has settled, so a prompt is never
  // left plain above coloured ones. One that fails to load leaves them all plain.
  let grammarSettled = $state(false)
  void warmLanguage('shell').finally(() => {
    grammarSettled = true
  })
</script>

{#snippet dot(state: 'waiting' | 'running' | 'failed' | 'done')}
  <span
    class="size-1.5 shrink-0 rounded-full"
    class:bg-amber={state === 'waiting'}
    class:bg-green={state === 'running'}
    class:animate-pulse={state === 'running' || state === 'waiting'}
    class:bg-red={state === 'failed'}
    class:bg-dim={state === 'done'}
    aria-hidden="true"
  ></span>
{/snippet}

<div class="flex h-full min-h-0 flex-col">
  <div class="flex h-7 shrink-0 items-center gap-1 border-b border-line px-1 text-2xs text-dim">
    <button
      class="flex items-center gap-1.5 rounded px-2 py-0.5 hover:text-default"
      class:bg-hover={activeTab === MAIN_TAB}
      class:text-default={activeTab === MAIN_TAB}
      title={meta?.title || 'Agent terminal'}
      onclick={() => selectTab(MAIN_TAB)}
    >
      {@render dot(mainState)}
      <span class="max-w-40 truncate">{meta?.title || 'Agent'}</span>
    </button>
    {#each backgroundTabs as id (id)}
      {@const command = commandOf(id)}
      {@const state = stateOf(command)}
      <div
        class="flex min-w-0 items-center gap-1.5 rounded px-2 py-0.5 hover:text-default"
        class:bg-hover={activeTab === id}
        class:text-default={activeTab === id}
      >
        <button class="flex min-w-0 items-center gap-1.5" title={command?.command} onclick={() => selectTab(id)}>
          {@render dot(state)}
          <span class="max-w-40 truncate font-mono">{command?.command ?? 'command'}</span>
        </button>
        {#if state === 'done' || state === 'failed'}
          <button class="shrink-0 hover:text-red" title="Close" onclick={() => closeTab(id)}>✕</button>
        {/if}
      </div>
    {/each}
    {#if activeState === 'waiting'}
      <span class="ml-auto shrink-0 pr-2 text-amber">Waiting for input — type here</span>
    {/if}
  </div>
  {#if !sessionId}
    <p class="p-3 text-xs text-dim">No agent session in this worktree.</p>
  {:else if commands.length === 0}
    <p class="p-3 text-xs text-dim">
      The commands this session runs show here as they run, and take what you type.
    </p>
  {/if}
  {#if sessionId}
    <div class="min-h-0 flex-1" class:hidden={commands.length === 0}>
      <AgentTerminalView
        bind:this={views[MAIN_TAB]}
        {leafId}
        {sessionId}
        commands={mainCommands}
        {grammarSettled}
        hidden={activeTab !== MAIN_TAB}
      />
      {#each backgroundTabs as id (id)}
        {@const command = commandOf(id)}
        <AgentTerminalView
          bind:this={views[id]}
          {leafId}
          {sessionId}
          commands={command ? [command] : []}
          {grammarSettled}
          hidden={activeTab !== id}
        />
      {/each}
    </div>
  {/if}
</div>
