<script lang="ts">
  // Preferences — a pane type rendering every registered settings schema
  // (base app + plugins) with the canonical form controls. A scope switcher
  // edits user- or project-level values; rows show a "modified" dot when the
  // viewed scope overrides the effective default.
  import { settings } from '../lib/settings.svelte'
  import { store } from '../lib/store.svelte'
  import { matchesQuery } from '../lib/overlays.svelte'
  import SettingToggle from './controls/SettingToggle.svelte'
  import SettingSelect from './controls/SettingSelect.svelte'
  import SettingTextInput from './controls/SettingTextInput.svelte'
  import SettingNumberInput from './controls/SettingNumberInput.svelte'
  import SettingColorInput from './controls/SettingColorInput.svelte'
  import KeybindCapture from './controls/KeybindCapture.svelte'
  import type { SettingDefinition, SettingScope, SettingsContribution } from '../../../shared/settings'
  import PaneControls from './PaneControls.svelte'
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon'
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon'

  let { leafId }: { leafId: string } = $props()

  let filter = $state('')
  let scope = $state<SettingScope>('user')

  const projectAvailable = $derived(store.repo !== null)

  function allowedInScope(definition: SettingDefinition): boolean {
    if (!definition.scopes) return true
    return definition.scopes.includes(scope)
  }

  function matchesFilter(definition: SettingDefinition): boolean {
    return matchesQuery(
      `${definition.title} ${definition.description ?? ''} ${definition.key}`,
      filter
    )
  }

  interface Section {
    contribution: SettingsContribution
    categories: { name: string; definitions: SettingDefinition[] }[]
  }

  const sections = $derived.by<Section[]>(() => {
    const result: Section[] = []
    for (const contribution of settings.contributions) {
      const visible = contribution.settings.filter(matchesFilter)
      if (visible.length === 0) continue
      const byCategory = new Map<string, SettingDefinition[]>()
      for (const definition of visible) {
        const category = definition.category ?? 'General'
        byCategory.set(category, [...(byCategory.get(category) ?? []), definition])
      }
      const categories = [...byCategory.entries()]
        .map(([name, definitions]) => ({ name, definitions }))
        .sort((a, b) => a.name.localeCompare(b.name))
      result.push({ contribution, categories })
    }
    return result
  })

  function effectiveValue(definition: SettingDefinition): unknown {
    const raw = settings.raw(definition.key, scope)
    if (raw !== undefined) return raw
    return settings.get(definition.key)
  }

  function isModified(definition: SettingDefinition): boolean {
    return settings.raw(definition.key, scope) !== undefined
  }

  function update(definition: SettingDefinition, value: unknown): void {
    void settings.set(definition.key, value, scope)
  }

  function reset(definition: SettingDefinition): void {
    void settings.set(definition.key, undefined, scope)
  }

  function openFile(): void {
    void window.workbench.settings.openFile(scope)
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
    <label
      class="flex w-64 items-center gap-2 rounded-lg border border-line bg-input px-2.5 py-1.5 transition-colors focus-within:border-line-strong hover:border-line-strong"
    >
      <MagnifyingGlassIcon size={13} class="shrink-0 text-faint" />
      <input
        type="text"
        class="min-w-0 flex-1 bg-transparent text-xs text-default placeholder:text-faint focus:outline-none"
        placeholder="Search settings…"
        bind:value={filter}
      />
    </label>
    <div class="flex gap-0.5 rounded-lg border border-line bg-input p-0.5 text-xs">
      <button
        class="rounded-md px-2.5 py-1 transition-colors"
        class:bg-raised={scope === 'user'}
        class:text-default={scope === 'user'}
        class:text-dim={scope !== 'user'}
        class:hover:text-default={scope !== 'user'}
        onclick={() => (scope = 'user')}
      >
        User
      </button>
      <button
        class="rounded-md px-2.5 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        class:bg-raised={scope === 'project'}
        class:text-default={scope === 'project'}
        class:text-dim={scope !== 'project'}
        class:hover:text-default={scope !== 'project'}
        disabled={!projectAvailable}
        title={projectAvailable ? '' : 'Open a repository to edit project settings'}
        onclick={() => (scope = 'project')}
      >
        Project
      </button>
    </div>
    <button class="ml-auto text-xs text-dim hover:text-default" onclick={openFile}>
      Open settings.json
    </button>
    <PaneControls />
  </div>

  <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
    {#each sections as section (section.contribution.contributorId)}
      <h2 class="mb-1 mt-4 text-sm font-semibold text-default first:mt-0">
        {section.contribution.title}
      </h2>
      {#each section.categories as category (category.name)}
        <h3 class="mb-1 mt-3 text-2xs font-semibold uppercase tracking-caps text-dim">
          {category.name}
        </h3>
        {#each category.definitions as definition (definition.key)}
          {@const disabled = !allowedInScope(definition)}
          <div class="flex items-start gap-3 border-b border-line/50 py-2.5">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                {#if isModified(definition)}
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Modified in this scope"></span>
                {/if}
                <span class="text-xs text-default">{definition.title}</span>
                <span class="font-mono text-2xs text-faint">{definition.key}</span>
              </div>
              {#if definition.description}
                <p class="mt-0.5 text-2xs text-dim">{definition.description}</p>
              {/if}
            </div>
            <div class="flex shrink-0 items-center gap-2">
              {#if definition.type === 'boolean'}
                <SettingToggle
                  value={Boolean(effectiveValue(definition))}
                  onchange={(next) => update(definition, next)}
                  {disabled}
                />
              {:else if definition.type === 'enum'}
                <SettingSelect
                  value={String(effectiveValue(definition) ?? '')}
                  options={definition.enumValues ?? []}
                  onchange={(next) => update(definition, next)}
                  {disabled}
                />
              {:else if definition.type === 'number'}
                <SettingNumberInput
                  value={Number(effectiveValue(definition) ?? 0)}
                  minimum={definition.minimum}
                  maximum={definition.maximum}
                  onchange={(next) => update(definition, next)}
                  {disabled}
                />
              {:else if definition.type === 'keybind'}
                <KeybindCapture
                  value={String(effectiveValue(definition) ?? '')}
                  onchange={(next) => update(definition, next)}
                  {disabled}
                />
              {:else if definition.type === 'color'}
                <SettingColorInput
                  value={String(effectiveValue(definition) ?? '#000000')}
                  onchange={(next) => update(definition, next)}
                  {disabled}
                />
              {:else}
                <SettingTextInput
                  value={String(effectiveValue(definition) ?? '')}
                  onchange={(next) => update(definition, next)}
                  {disabled}
                />
              {/if}
              {#if isModified(definition)}
                <button
                  class="flex h-6 w-6 items-center justify-center rounded-md text-dim transition-colors hover:bg-hover hover:text-default"
                  title="Reset to default"
                  onclick={() => reset(definition)}
                >
                  <ArrowCounterClockwiseIcon size={13} />
                </button>
              {/if}
            </div>
          </div>
        {/each}
      {/each}
    {/each}
    {#if sections.length === 0}
      <p class="py-6 text-xs text-dim">No settings match.</p>
    {/if}
  </div>
</div>
