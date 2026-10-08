<script lang="ts">
  // The issues of the list on a month: each on the day its date field is set to,
  // the ones without a date in a column beside it. Dragging an issue onto a day
  // sets the field on GitHub; dragging it to "No date" clears it. Open issues
  // whose day has passed are marked, so what is late stands out.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon'
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon'
  import RowAction from '../gitChanges/RowAction.svelte'
  import {
    dateOf,
    dayString,
    isOverdue,
    monthGrid,
    monthOf,
    monthTitle,
    placeIssues,
    shiftMonth
  } from './calendar'
  import { github, moveIssueToDay, prefetchItem } from './store.svelte'
  import type { GithubIssueDateField, GithubIssueItem } from '../../../../../shared/types'

  let {
    field,
    onopen
  }: {
    field: GithubIssueDateField
    onopen: (number: number) => void
  } = $props()

  const DRAG_TYPE = 'application/x-grove-issue'
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  // Where a dropped issue goes when it lands on "No date" rather than a day.
  const UNDATED = 'undated'

  const issues = $derived(
    github.items.filter((item): item is GithubIssueItem => item.kind === 'issue')
  )
  const placed = $derived(placeIssues(issues, field.id))
  const weeks = $derived(monthGrid(github.calendarMonth))
  const today = dayString(new Date())

  /** The day or "No date" a dragged issue is over, so it can show it will take the drop. */
  let dropTarget = $state<string | null>(null)

  /** The issues on a day. */
  function issuesOn(date: string): GithubIssueItem[] {
    const onDay = placed.byDay.get(date)
    if (!onDay) return []
    return onDay
  }

  /** Hands the issue's number to the drop, which looks the issue up again. */
  function startDrag(event: DragEvent, issue: GithubIssueItem): void {
    if (!event.dataTransfer) return
    event.dataTransfer.setData(DRAG_TYPE, String(issue.number))
    event.dataTransfer.effectAllowed = 'move'
  }

  /** Accepts an issue being dragged over a day or "No date", and nothing else. */
  function dragOver(event: DragEvent, target: string): void {
    if (!event.dataTransfer || !event.dataTransfer.types.includes(DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    dropTarget = target
  }

  /** Forgets the highlight once the pointer leaves the target itself, not an issue inside it. */
  function dragLeave(event: DragEvent, target: string): void {
    const into = event.relatedTarget
    if (into instanceof Node && (event.currentTarget as HTMLElement).contains(into)) return
    if (dropTarget === target) dropTarget = null
  }

  /** Puts the dropped issue on the day, or takes its date off for "No date". */
  function drop(event: DragEvent, target: string): void {
    dropTarget = null
    if (!event.dataTransfer) return
    event.preventDefault()
    const number = Number(event.dataTransfer.getData(DRAG_TYPE))
    const issue = issues.find((candidate) => candidate.number === number)
    if (!issue) return
    let date: string | null = target
    if (target === UNDATED) date = null
    if (dateOf(issue, field.id) === date) return
    void moveIssueToDay(issue, date)
  }

  function isSelected(number: number): boolean {
    const selection = github.selection
    if (!selection) return false
    return selection.kind === 'issue' && selection.number === number
  }
</script>

{#snippet chip(issue: GithubIssueItem, date: string | null)}
  {@const late = date !== null && isOverdue(issue, date, today)}
  <button
    class="flex w-full min-w-0 cursor-pointer items-baseline gap-1 rounded border px-1 py-0.5 text-left text-2xs hover:bg-hover"
    class:border-line={!isSelected(issue.number) && !late}
    class:border-line-strong={isSelected(issue.number)}
    class:border-red={late && !isSelected(issue.number)}
    class:bg-surface={!late}
    class:bg-red-soft={late}
    draggable="true"
    title="#{issue.number} {issue.title}"
    ondragstart={(event) => startDrag(event, issue)}
    onmouseenter={() => prefetchItem('issue', issue.number)}
    onclick={() => onopen(issue.number)}
  >
    <span class="shrink-0 font-mono text-dim">#{issue.number}</span>
    <span class="truncate text-default">{issue.title}</span>
  </button>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex shrink-0 items-center gap-1 px-2 py-1">
    <RowAction
      icon={CaretLeftIcon}
      title="Previous month"
      onclick={() => (github.calendarMonth = shiftMonth(github.calendarMonth, -1))}
    />
    <RowAction
      icon={CaretRightIcon}
      title="Next month"
      onclick={() => (github.calendarMonth = shiftMonth(github.calendarMonth, 1))}
    />
    <h3 class="text-xs font-semibold text-default">{monthTitle(github.calendarMonth)}</h3>
    <button
      class="ml-1 cursor-pointer rounded-md px-1.5 py-0.5 text-2xs text-dim hover:bg-hover hover:text-default"
      onclick={() => (github.calendarMonth = monthOf(new Date()))}
    >
      Today
    </button>
  </div>

  <div class="flex min-h-0 flex-1 gap-2 px-2 pb-2">
    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-line">
      <div class="grid shrink-0 grid-cols-7 border-b border-line bg-canvas">
        {#each WEEKDAYS as weekday (weekday)}
          <span class="px-1.5 py-1 text-2xs text-dim">{weekday}</span>
        {/each}
      </div>
      <div class="grid min-h-0 flex-1 auto-rows-fr">
        {#each weeks as week (week[0].date)}
          <div class="grid min-h-0 grid-cols-7 border-b border-line last:border-b-0">
            {#each week as day (day.date)}
              <section
                class="flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden border-r border-line p-1 last:border-r-0"
                class:bg-canvas={!day.inMonth}
                class:bg-hover={dropTarget === day.date}
                aria-label={day.date}
                ondragover={(event) => dragOver(event, day.date)}
                ondragleave={(event) => dragLeave(event, day.date)}
                ondrop={(event) => drop(event, day.date)}
              >
                <span
                  class="self-start rounded px-1 font-mono text-2xs"
                  class:text-dim={day.date !== today}
                  class:bg-action={day.date === today}
                  class:text-action-fg={day.date === today}
                >
                  {day.dayOfMonth}
                </span>
                {#each issuesOn(day.date) as issue (issue.number)}
                  {@render chip(issue, day.date)}
                {/each}
              </section>
            {/each}
          </div>
        {/each}
      </div>
    </div>

    <section
      class="flex min-h-0 w-48 shrink-0 flex-col rounded-lg border bg-canvas"
      class:border-line={dropTarget !== UNDATED}
      class:border-line-strong={dropTarget === UNDATED}
      aria-label="No {field.name.toLowerCase()}"
      ondragover={(event) => dragOver(event, UNDATED)}
      ondragleave={(event) => dragLeave(event, UNDATED)}
      ondrop={(event) => drop(event, UNDATED)}
    >
      <h3
        class="flex shrink-0 items-center gap-1.5 px-2 pb-1 pt-2 text-xs font-semibold text-muted"
      >
        No {field.name.toLowerCase()}
        <span class="font-mono text-2xs font-normal text-dim">{placed.undated.length}</span>
      </h3>
      <FloatingScrollbar class="min-h-0 flex-1">
        <div class="flex flex-col gap-1 p-1.5 pt-0.5">
          {#each placed.undated as issue (issue.number)}
            {@render chip(issue, null)}
          {/each}
        </div>
      </FloatingScrollbar>
    </section>
  </div>
</div>
