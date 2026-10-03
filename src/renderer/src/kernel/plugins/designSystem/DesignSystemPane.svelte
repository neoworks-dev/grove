<script lang="ts">
  // A specimen sheet for @neoworks-dev/ui: every primitive in its variants,
  // rendered against Grove's own theme so it shows how they look in the app.
  // NavBar is left out — its items are hrefs, and following one would navigate
  // the whole window away from the app.
  import {
    Button,
    Card,
    Checkbox,
    DatePicker,
    FloatingScrollbar,
    IconCircle,
    ListRow,
    LoadingSpinner,
    PegboardCanvas,
    SchemaDiagram,
    SectionHeader,
    Select,
    StatusBadge,
    TimePicker,
    Tooltip,
    WheelColumn,
    type CanvasRelation,
    type CanvasTable,
    type StatusTone
  } from '@neoworks-dev/ui'
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon'
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon'
  import GitBranchIcon from 'phosphor-svelte/lib/GitBranchIcon'
  import FolderIcon from 'phosphor-svelte/lib/FolderIcon'
  import TerminalWindowIcon from 'phosphor-svelte/lib/TerminalWindowIcon'

  const BUTTON_VARIANTS = ['primary', 'surface', 'ghost', 'success', 'danger'] as const
  const BUTTON_SIZES = ['sm', 'md', 'lg'] as const
  const TONES: StatusTone[] = ['neutral', 'green', 'red', 'amber', 'blue', 'violet']
  const CARD_SURFACES = ['surface', 'elevated', 'raised'] as const

  const BRANCH_OPTIONS = [
    { value: 'main', label: 'main', icon: GitBranchIcon, description: 'What has been reviewed' },
    { value: 'next', label: 'next', icon: GitBranchIcon, description: 'What Grove runs from' },
    { value: 'feature', label: '12-tab-strip-overflow', icon: GitBranchIcon }
  ]
  const AREA_OPTIONS = [
    { value: 'editor', label: 'area:editor' },
    { value: 'agents', label: 'area:agents' },
    { value: 'panes', label: 'area:panes' },
    { value: 'sidebar', label: 'area:sidebar' },
    { value: 'git', label: 'area:git' }
  ]
  const PERCENTAGES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

  const SCHEMA_TABLES: CanvasTable[] = [
    {
      id: 'session',
      x: 16,
      y: 16,
      def: {
        name: 'session',
        schemafull: true,
        fields: [
          { name: 'id', type: 'string' },
          { name: 'worktree', type: 'string' },
          { name: 'harness', type: 'string' }
        ],
        indexes: []
      }
    },
    {
      id: 'event',
      x: 320,
      y: 64,
      def: {
        name: 'event',
        schemafull: true,
        fields: [
          { name: 'id', type: 'string' },
          { name: 'session', type: 'record<session>' },
          { name: 'payload', type: 'object' }
        ],
        indexes: [{ name: 'by_session', fields: ['session'], unique: false }]
      }
    }
  ]
  const SCHEMA_RELATIONS: CanvasRelation[] = [
    { id: 'session-events', fromTableId: 'session', toTableId: 'event', label: 'has' }
  ]

  let branch = $state('main')
  let areas = $state<string[]>(['editor'])
  let searchedArea = $state('panes')
  let checkedSmall = $state(true)
  let checkedMedium = $state(false)
  let date = $state<Date | null>(new Date())
  let time = $state('09:30')
  let percentage = $state(50)
  let clickCount = $state(0)

  /** Case-insensitive label match for the searchable select. */
  function matchesLabel(option: { label: string }, query: string): boolean {
    return option.label.toLowerCase().includes(query.toLowerCase())
  }

  /** Counts presses so the buttons visibly do something. */
  function countClick(): void {
    clickCount += 1
  }
</script>

<FloatingScrollbar class="h-full min-h-0 flex-1">
  <div class="flex flex-col gap-8 p-6">
    <header class="flex flex-col gap-1">
      <h1 class="text-lg font-semibold text-default">Design system</h1>
      <p class="text-sm text-dim">Every primitive in @neoworks-dev/ui, on Grove's theme.</p>
    </header>

    <section class="flex flex-col gap-3">
      <SectionHeader title="Button">
        {#snippet action()}
          <span class="text-xs text-dim">{clickCount} clicks</span>
        {/snippet}
      </SectionHeader>
      {#each BUTTON_SIZES as size (size)}
        <div class="flex flex-wrap items-center gap-2">
          {#each BUTTON_VARIANTS as variant (variant)}
            <Button {variant} {size} onclick={countClick}>{variant} {size}</Button>
          {/each}
        </div>
      {/each}
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={PlusIcon} onclick={countClick}>With icon</Button>
        <Button variant="danger" icon={TrashIcon} onclick={countClick}>Delete</Button>
        <Button variant="primary" disabled>Disabled</Button>
        <Button round icon={PlusIcon} onclick={countClick} />
        <Button round variant="ghost" icon={TrashIcon} onclick={countClick} />
      </div>
      <div class="max-w-sm">
        <Button variant="surface" full onclick={countClick}>Full width</Button>
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <SectionHeader title="Select" />
      <div class="flex flex-wrap items-center gap-3">
        <Select
          value={branch}
          options={BRANCH_OPTIONS}
          onChange={(value) => (branch = value as string)}
        />
        <Select
          value={areas}
          options={AREA_OPTIONS}
          multiple
          placeholder="Labels"
          onChange={(value) => (areas = value as string[])}
        />
        <Select
          value={searchedArea}
          options={AREA_OPTIONS}
          filter={matchesLabel}
          searchPlaceholder="Find an area"
          onChange={(value) => (searchedArea = value as string)}
        />
        <Select
          value={branch}
          options={BRANCH_OPTIONS}
          size="sm"
          onChange={(value) => (branch = value as string)}
        />
        <Select
          value={branch}
          options={BRANCH_OPTIONS}
          variant="ghost"
          onChange={(value) => (branch = value as string)}
        />
        <Select value="" options={BRANCH_OPTIONS} disabled onChange={() => {}} />
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <SectionHeader title="Checkbox" />
      <div class="flex items-center gap-6 text-sm text-default">
        <label class="flex items-center gap-2">
          <Checkbox size="sm" bind:checked={checkedSmall} /> Small
        </label>
        <label class="flex items-center gap-2">
          <Checkbox bind:checked={checkedMedium} /> Medium
        </label>
        <label class="flex items-center gap-2 text-dim">
          <Checkbox checked disabled /> Disabled
        </label>
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <SectionHeader title="Date, time and wheel" />
      <div class="flex flex-wrap items-center gap-4">
        <DatePicker value={date} onChange={(value) => (date = value)} />
        <DatePicker value={date} variant="field" onChange={(value) => (date = value)} />
        <DatePicker value={null} variant="field" onChange={(value) => (date = value)} />
        <TimePicker value={time} onChange={(value) => (time = value)} />
      </div>
      <div class="flex items-center gap-4">
        <div class="h-40 w-20">
          <WheelColumn
            values={PERCENTAGES}
            value={percentage}
            wrap={false}
            format={(value) => `${value}%`}
            onChange={(value) => (percentage = value)}
          />
        </div>
        <span class="text-sm text-dim">{percentage}%</span>
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <SectionHeader title="StatusBadge and IconCircle" />
      <div class="flex flex-wrap items-center gap-2">
        {#each TONES as tone (tone)}
          <StatusBadge {tone}>{tone}</StatusBadge>
        {/each}
      </div>
      <div class="flex flex-wrap items-center gap-3">
        {#each TONES as tone (tone)}
          <IconCircle icon={CheckIcon} {tone} />
        {/each}
        <IconCircle icon={GitBranchIcon} size="sm" />
        <IconCircle icon={GitBranchIcon} size="md" />
        <IconCircle icon={GitBranchIcon} size="lg" />
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <SectionHeader title="Card" />
      <div class="grid grid-cols-3 gap-3">
        {#each CARD_SURFACES as surface (surface)}
          <Card {surface}>
            <p class="text-sm text-default">{surface}</p>
            <p class="text-xs text-dim">padding md</p>
          </Card>
        {/each}
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <SectionHeader title="ListRow" />
      <Card surface="elevated" padding="none">
        <ListRow title="src" subtitle="Folder" chevron onclick={countClick}>
          {#snippet leading()}
            <IconCircle icon={FolderIcon} size="sm" tone="blue" />
          {/snippet}
        </ListRow>
        <ListRow title="Terminal" subtitle="zsh · idle" onclick={countClick}>
          {#snippet leading()}
            <IconCircle icon={TerminalWindowIcon} size="sm" />
          {/snippet}
          {#snippet trailing()}
            <StatusBadge tone="green">running</StatusBadge>
          {/snippet}
        </ListRow>
        <ListRow title="Plain row" />
      </Card>
    </section>

    <section class="flex flex-col gap-3">
      <SectionHeader title="Tooltip and LoadingSpinner" />
      <div class="flex flex-wrap items-center gap-4">
        <Tooltip text="Above, the default">
          <Button>Top</Button>
        </Tooltip>
        <Tooltip text="Below" placement="bottom">
          <Button>Bottom</Button>
        </Tooltip>
        <Tooltip placement="right">
          {#snippet content()}
            <span class="font-semibold">Rich</span> content
          {/snippet}
          <Button>Snippet</Button>
        </Tooltip>
        <LoadingSpinner size={16} />
        <LoadingSpinner />
        <LoadingSpinner size={36} class="text-accent" />
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <SectionHeader title="PegboardCanvas" />
      <div class="relative h-40 overflow-hidden rounded-lg border border-line-faint">
        <PegboardCanvas />
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <SectionHeader title="SchemaDiagram" />
      <div class="relative h-80 overflow-hidden rounded-lg border border-line-faint">
        <SchemaDiagram tables={SCHEMA_TABLES} relations={SCHEMA_RELATIONS} panX={0} panY={0} />
      </div>
    </section>
  </div>
</FloatingScrollbar>
