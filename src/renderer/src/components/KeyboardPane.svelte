<script lang="ts">
  // Keyboard configuration — lists every registered binding with its effective
  // keys and source, supports rebinding/unbinding/resetting via the settings
  // provider, flags conflicts, and creates new custom bindings that run a
  // command, a shell command, or an AI prompt.
  import { keymap } from '../lib/keymap.svelte'
  import { settings } from '../lib/settings.svelte'
  import { commands } from '../lib/commands.svelte'
  import { store } from '../lib/store.svelte'
  import { matchesQuery } from '../lib/overlays.svelte'
  import {
    resolveDefaultBindings,
    readCustomBindings,
    readOverrideMap,
    type BindingSource
  } from '../lib/bindingResolution'
  import { parseSequence, findConflicts, type ConflictEntry } from '../lib/keySequence'
  import KeybindCapture from './controls/KeybindCapture.svelte'
  import type { CustomBinding, KeybindAction } from '../../../shared/actions'
  import type { SettingScope } from '../../../shared/settings'
  import PaneControls from './PaneControls.svelte'
  import RowAction from '../kernel/plugins/gitChanges/RowAction.svelte'
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon'
  import ProhibitIcon from 'phosphor-svelte/lib/ProhibitIcon'
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon'
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import XIcon from 'phosphor-svelte/lib/XIcon'

  let { leafId }: { leafId: string } = $props()

  let filter = $state('')

  interface Row {
    id: string
    description: string
    group: string
    context: string
    keys: string
    source: BindingSource
    unbound: boolean
    custom: CustomBinding | null
    customScope: SettingScope | null
  }

  const userOverrides = $derived(readOverrideMap(settings.userValues['keybindings.overrides']))
  const projectOverrides = $derived(
    readOverrideMap(settings.projectValues['keybindings.overrides'])
  )

  const rows = $derived.by<Row[]>(() => {
    const byId = new Map(keymap.bindings.map((binding) => [binding.id, binding]))
    const resolved = resolveDefaultBindings(keymap.bindings, userOverrides, projectOverrides)
    const defaults: Row[] = resolved.map((entry) => {
      const base = byId.get(entry.id)
      return {
        id: entry.id,
        description: base?.description ?? entry.id,
        group: base?.group ?? '',
        context: base?.context ?? 'global',
        keys: entry.unbound ? '' : entry.keys,
        source: entry.source,
        unbound: entry.unbound,
        custom: null,
        customScope: null
      }
    })
    const customs: Row[] = [
      ...readCustomBindings(settings.userValues['keybindings.custom'], 'custom-user'),
      ...readCustomBindings(settings.projectValues['keybindings.custom'], 'custom-project')
    ].map((entry) => ({
      id: entry.binding.id,
      description: entry.binding.description,
      group: 'Custom',
      context: entry.binding.context ?? 'global',
      keys: entry.binding.keys,
      source: entry.source,
      unbound: false,
      custom: entry.binding,
      customScope: entry.source === 'custom-project' ? 'project' : 'user'
    }))
    return [...defaults, ...customs]
      .filter((row) =>
        matchesQuery(`${row.description} ${row.id} ${row.keys} ${row.group}`, filter)
      )
      .sort((a, b) => a.group.localeCompare(b.group) || a.description.localeCompare(b.description))
  })

  interface Group {
    name: string
    rows: Row[]
  }

  // Rows arrive sorted by group, so each group is one contiguous run.
  const groups = $derived.by<Group[]>(() => {
    const result: Group[] = []
    for (const row of rows) {
      const name = row.group || 'General'
      const last = result[result.length - 1]
      if (last && last.name === name) {
        last.rows.push(row)
        continue
      }
      result.push({ name, rows: [row] })
    }
    return result
  })

  const conflictIds = $derived.by<Set<string>>(() => {
    const entries: ConflictEntry[] = []
    for (const row of rows) {
      if (row.unbound || !row.keys) continue
      const sequence = parseSequence(row.keys)
      if (sequence) entries.push({ id: row.id, context: row.context, sequence })
    }
    const ids = new Set<string>()
    for (const conflict of findConflicts(entries)) {
      ids.add(conflict.firstId)
      ids.add(conflict.secondId)
    }
    return ids
  })

  // Default bindings carry no label; only where a binding came from otherwise.
  const sourceLabels: Record<BindingSource, string> = {
    default: '',
    user: 'user',
    project: 'project',
    'custom-user': 'custom',
    'custom-project': 'custom (project)'
  }

  // ── Override mutations ────────────────────────────────────────
  async function writeOverride(
    id: string,
    keys: string | null,
    scope: SettingScope
  ): Promise<void> {
    const current = scope === 'user' ? userOverrides : projectOverrides
    await settings.set('keybindings.overrides', { ...current, [id]: keys }, scope)
  }

  async function rebind(row: Row, keys: string): Promise<void> {
    if (row.custom && row.customScope) {
      await updateCustom(row.customScope, row.custom.id, { keys })
      return
    }
    await writeOverride(row.id, keys, 'user')
  }

  async function unbind(row: Row): Promise<void> {
    await writeOverride(row.id, null, 'user')
  }

  async function resetToDefault(row: Row): Promise<void> {
    for (const scope of ['user', 'project'] as SettingScope[]) {
      const current = scope === 'user' ? userOverrides : projectOverrides
      if (!(row.id in current)) continue
      const next = { ...current }
      delete next[row.id]
      await settings.set('keybindings.overrides', next, scope)
    }
  }

  function hasOverride(row: Row): boolean {
    return row.id in userOverrides || row.id in projectOverrides
  }

  // ── Custom bindings ───────────────────────────────────────────
  function customList(scope: SettingScope): CustomBinding[] {
    const raw =
      scope === 'user'
        ? settings.userValues['keybindings.custom']
        : settings.projectValues['keybindings.custom']
    if (!Array.isArray(raw)) return []
    return raw as CustomBinding[]
  }

  async function updateCustom(
    scope: SettingScope,
    id: string,
    patch: Partial<CustomBinding>
  ): Promise<void> {
    const next = customList(scope).map((binding) =>
      binding.id === id ? { ...binding, ...patch } : binding
    )
    await settings.set('keybindings.custom', next, scope)
  }

  async function deleteCustom(row: Row): Promise<void> {
    if (!row.custom || !row.customScope) return
    const next = customList(row.customScope).filter((binding) => binding.id !== row.custom!.id)
    await settings.set('keybindings.custom', next, row.customScope)
  }

  // ── Add-binding form ──────────────────────────────────────────
  let adding = $state(false)
  let newType = $state<'command' | 'shell' | 'ai-prompt'>('command')
  let newCommandId = $state('')
  let newShell = $state('')
  let newPrompt = $state('')
  let newAutoSend = $state(false)
  let newAgent = $state('')
  let newKeys = $state('')
  let newDescription = $state('')
  let newContext = $state('global')
  let newScope = $state<SettingScope>('user')

  const commandOptions = $derived(
    [...commands.commands].sort((a, b) => a.title.localeCompare(b.title))
  )

  function buildAction(): KeybindAction | null {
    if (newType === 'command') {
      if (!newCommandId) return null
      return { type: 'command', commandId: newCommandId }
    }
    if (newType === 'shell') {
      if (!newShell.trim()) return null
      return { type: 'shell', commandLine: newShell.trim() }
    }
    if (!newPrompt.trim()) return null
    return {
      type: 'ai-prompt',
      prompt: newPrompt.trim(),
      autoSend: newAutoSend,
      agent: newAgent || undefined
    }
  }

  async function saveNewBinding(): Promise<void> {
    const action = buildAction()
    if (!action || !newKeys || !parseSequence(newKeys)) return
    const binding: CustomBinding = {
      id: `custom.${Math.random().toString(36).slice(2, 10)}`,
      keys: newKeys,
      description: newDescription.trim() || describeAction(action),
      context: newContext.trim() || 'global',
      action
    }
    await settings.set('keybindings.custom', [...customList(newScope), binding], newScope)
    adding = false
    newCommandId = ''
    newShell = ''
    newPrompt = ''
    newKeys = ''
    newDescription = ''
  }

  function describeAction(action: KeybindAction): string {
    if (action.type === 'command') {
      return (
        commands.commands.find((entry) => entry.id === action.commandId)?.title ?? action.commandId
      )
    }
    if (action.type === 'shell') return action.commandLine
    return `AI: ${action.prompt.slice(0, 40)}`
  }
</script>


<div class="flex h-full min-h-0 flex-col">
  <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
    <input
      type="text"
      class="min-w-0 flex-1 rounded-md border border-line bg-input px-2 py-1 text-xs"
      placeholder="Search keybindings…"
      bind:value={filter}
    />
    <button
      class="grid size-6 shrink-0 place-items-center rounded-md text-dim hover:bg-hover hover:text-default"
      title={adding ? 'Close' : 'Add binding'}
      aria-label={adding ? 'Close' : 'Add binding'}
      onclick={() => (adding = !adding)}
    >
      {#if adding}
        <XIcon size={14} />
      {:else}
        <PlusIcon size={14} />
      {/if}
    </button>
    <PaneControls />
  </div>

  {#if adding}
    <div class="grid shrink-0 grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] items-end gap-3 border-b border-line px-3 py-3">
      <label class="flex flex-col gap-1 text-2xs text-dim">
        Action
        <select
          class="rounded-md border border-line bg-input px-2 py-1 text-xs text-default"
          bind:value={newType}
        >
          <option value="command">Run command</option>
          <option value="shell">Shell command</option>
          <option value="ai-prompt">AI prompt</option>
        </select>
      </label>
      {#if newType === 'command'}
        <label class="flex flex-col gap-1 text-2xs text-dim">
          Command
          <select
            class="w-full rounded-md border border-line bg-input px-2 py-1 text-xs text-default"
            bind:value={newCommandId}
          >
            <option value="">— pick a command —</option>
            {#each commandOptions as command (command.id)}
              <option value={command.id}>{command.title}</option>
            {/each}
          </select>
        </label>
      {:else if newType === 'shell'}
        <label class="flex flex-col gap-1 text-2xs text-dim">
          Command line (supports {'${PORT_0}'}, $WT_PATH…)
          <input
            type="text"
            class="w-full rounded-md border border-line bg-input px-2 py-1 font-mono text-xs text-default"
            placeholder="bun test"
            bind:value={newShell}
          />
        </label>
      {:else}
        <label class="flex flex-col gap-1 text-2xs text-dim">
          Prompt
          <textarea
            class="h-14 w-full rounded-md border border-line bg-input px-2 py-1 text-xs text-default"
            bind:value={newPrompt}
          ></textarea>
        </label>
        <label class="flex items-center gap-1.5 text-2xs text-dim">
          <input type="checkbox" bind:checked={newAutoSend} />
          Send immediately
        </label>
      {/if}
      <label class="flex flex-col gap-1 text-2xs text-dim">
        Keys
        <KeybindCapture value={newKeys} onchange={(next) => (newKeys = next)} />
      </label>
      <label class="flex flex-col gap-1 text-2xs text-dim">
        Description
        <input
          type="text"
          class="w-full rounded-md border border-line bg-input px-2 py-1 text-xs text-default"
          bind:value={newDescription}
        />
      </label>
      <label class="flex flex-col gap-1 text-2xs text-dim">
        Scope
        <select
          class="rounded-md border border-line bg-input px-2 py-1 text-xs text-default"
          bind:value={newScope}
        >
          <option value="user">User</option>
          <option value="project" disabled={!store.repo}>Project</option>
        </select>
      </label>
      <button
        class="rounded-md border border-accent bg-accent px-3 py-1.5 text-xs text-accent-content hover:opacity-90"
        onclick={() => void saveNewBinding()}
      >
        Save
      </button>
    </div>
  {/if}

  <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-2">
    {#each groups as group (group.name)}
      <p
        class="sticky top-0 z-10 bg-surface px-3 pt-3 pb-1 text-2xs font-semibold uppercase tracking-caps text-dim"
      >
        {group.name}
      </p>
      {#each group.rows as row (row.id)}
        <div
          class="group/row flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 text-xs hover:bg-hover/40 focus-within:bg-hover/40"
        >
          <div class="flex min-w-0 flex-1 basis-32 items-center gap-1.5">
            <span class="truncate text-muted" title={row.description}>{row.description}</span>
            {#if row.context !== 'global'}
              <span class="shrink-0 font-mono text-2xs text-faint" title="Only active in {row.context}"
                >{row.context}</span
              >
            {/if}
            {#if sourceLabels[row.source]}
              <span class="shrink-0 rounded border border-line px-1 text-2xs text-dim"
                >{sourceLabels[row.source]}</span
              >
            {/if}
            {#if conflictIds.has(row.id)}
              <span class="shrink-0 text-2xs text-amber" title="Conflicts with another binding"
                >⚠ conflict</span
              >
            {/if}
          </div>
          <div class="ml-auto flex max-w-full min-w-0 items-center gap-1">
            <div class="hidden items-center group-focus-within/row:flex group-hover/row:flex">
              {#if row.custom}
                <RowAction icon={TrashIcon} title="Delete" onclick={() => void deleteCustom(row)} />
              {:else}
                {#if hasOverride(row)}
                  <RowAction
                    icon={ArrowCounterClockwiseIcon}
                    title="Reset to default"
                    onclick={() => void resetToDefault(row)}
                  />
                {/if}
                {#if !row.unbound}
                  <RowAction icon={ProhibitIcon} title="Unbind" onclick={() => void unbind(row)} />
                {/if}
              {/if}
            </div>
            <KeybindCapture
              value={row.unbound ? '' : row.keys}
              onchange={(next) => void rebind(row, next)}
            />
          </div>
        </div>
      {/each}
    {/each}
    {#if rows.length === 0}
      <p class="px-3 py-6 text-xs text-dim">No bindings match.</p>
    {/if}
  </div>
</div>
