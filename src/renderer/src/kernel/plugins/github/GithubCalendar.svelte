<script lang="ts">
  // The issues of the list on a month, each a bar from its start date to its
  // end date, the ones without a date in a column beside it. Dragging a bar onto
  // a day moves it there, keeping its length; dragging one of its ends stretches
  // it; dragging it to "No date" clears its dates. Open issues whose last day
  // has passed are marked, so what is late stands out.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon'
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon'
  import RowAction from '../gitChanges/RowAction.svelte'
  import {
    addDays,
    clearedDates,
    daysBetween,
    dayString,
    isOverdue,
    monthGrid,
    monthOf,
    monthTitle,
    movedDates,
    placeIssues,
    resizedDates,
    shiftMonth,
    spanOf,
    weekBars,
    withDateValues,
    type CalendarDay,
    type CalendarRange,
    type IssueSpan,
    type WeekBar
  } from './calendar'
  import { github, prefetchItem, setIssueDates } from './store.svelte'
  import type { GithubIssueItem } from '../../../../../shared/types'

  let {
    range,
    onopen
  }: {
    range: CalendarRange
    onopen: (number: number) => void
  } = $props()

  const DRAG_TYPE = 'application/x-grove-issue'
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  // Where a dropped issue goes when it lands on "No date" rather than a day.
  const UNDATED = 'undated'

  const issues = $derived(
    github.items.filter((item): item is GithubIssueItem => item.kind === 'issue')
  )
  const placed = $derived(placeIssues(issues, range))
  const weeks = $derived(monthGrid(github.calendarMonth))
  const today = dayString(new Date())
  const undatedLabel = $derived.by(() => {
    if (range.end) return 'No dates'
    return `No ${range.start.name.toLowerCase()}`
  })

  /** The day or "No date" a dragged issue is over, so it can show it will take the drop. */
  let dropTarget = $state<string | null>(null)

  /** The bar end being dragged, and the day it is over so far. */
  let resizing = $state<{ span: IssueSpan; edge: 'start' | 'end'; day: string } | null>(null)

  /** The spans as shown: the one being stretched at its new length until it is let go. */
  const shownSpans = $derived.by(() => {
    const active = resizing
    if (!active) return placed.spans
    return placed.spans.map((span) => {
      if (span.issue.number !== active.span.issue.number) return span
      const preview = withDateValues(
        span.issue,
        resizedDates(active.span, range, active.edge, active.day)
      )
      const stretched = spanOf(preview, range)
      if (!stretched) return span
      return stretched
    })
  })

  /**
   * How many days into its bar an issue was grabbed, so the drop puts that day,
   * not the bar's first, under the pointer.
   */
  let grabOffset = 0

  /** Hands the issue's number to the drop, which looks the issue up again. */
  function startDrag(event: DragEvent, issue: GithubIssueItem): void {
    if (resizing || !event.dataTransfer) {
      event.preventDefault()
      return
    }
    event.dataTransfer.setData(DRAG_TYPE, String(issue.number))
    event.dataTransfer.effectAllowed = 'move'
    grabOffset = 0
    const span = spanOf(issue, range)
    const grabbed = dayAt(event.clientX, event.clientY)
    if (span && grabbed !== null) grabOffset = daysBetween(span.start, grabbed)
  }

  /** The day of a week under the pointer, read from where across the week it is. */
  function dayIn(week: CalendarDay[], element: Element, clientX: number): string {
    const rect = element.getBoundingClientRect()
    let column = Math.floor(((clientX - rect.left) / rect.width) * week.length)
    column = Math.max(0, Math.min(week.length - 1, column))
    return week[column].date
  }

  /** The day under a point anywhere on the calendar, or null when it is off the weeks. */
  function dayAt(clientX: number, clientY: number): string | null {
    const under = document.elementFromPoint(clientX, clientY)
    if (!under) return null
    const weekElement = under.closest<HTMLElement>('[data-week]')
    if (!weekElement) return null
    const week = weeks[Number(weekElement.dataset.week)]
    if (!week) return null
    return dayIn(week, weekElement, clientX)
  }

  /** Accepts an issue dragged over a week, lighting the day it is over. */
  function dragOverWeek(event: DragEvent, week: CalendarDay[]): void {
    if (!accepts(event)) return
    dropTarget = dayIn(week, event.currentTarget as Element, event.clientX)
  }

  /** Accepts an issue dragged over "No date". */
  function dragOverUndated(event: DragEvent): void {
    if (!accepts(event)) return
    dropTarget = UNDATED
  }

  /** Whether the drag is an issue, taking it as a move if so. */
  function accepts(event: DragEvent): boolean {
    if (!event.dataTransfer || !event.dataTransfer.types.includes(DRAG_TYPE)) return false
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    return true
  }

  /** Forgets the highlight once the pointer leaves the target itself, not something inside it. */
  function dragLeave(event: DragEvent): void {
    const into = event.relatedTarget
    if (into instanceof Node && (event.currentTarget as HTMLElement).contains(into)) return
    dropTarget = null
  }

  /** The issue a drop carries, or null when it carries none of the list's. */
  function droppedIssue(event: DragEvent): GithubIssueItem | null {
    if (!event.dataTransfer) return null
    event.preventDefault()
    const number = Number(event.dataTransfer.getData(DRAG_TYPE))
    const issue = issues.find((candidate) => candidate.number === number)
    if (!issue) return null
    return issue
  }

  /** Starts the dropped issue on the day, keeping its length. */
  function dropOnWeek(event: DragEvent, week: CalendarDay[]): void {
    dropTarget = null
    const issue = droppedIssue(event)
    if (!issue) return
    const day = addDays(dayIn(week, event.currentTarget as Element, event.clientX), -grabOffset)
    let span = spanOf(issue, range)
    if (!span) span = { issue, start: day, end: day }
    if (span.start === day && spanOf(issue, range) !== null) return
    void setIssueDates(issue, movedDates(span, range, day))
  }

  /** Takes the dropped issue's dates off. */
  function dropOnUndated(event: DragEvent): void {
    dropTarget = null
    const issue = droppedIssue(event)
    if (!issue || spanOf(issue, range) === null) return
    void setIssueDates(issue, clearedDates(range))
  }

  /**
   * Starts stretching a bar from one of its ends. The pointer is followed on the
   * window, since the handle it was pressed on is redrawn, or gone to another
   * week's piece of the bar, as the bar grows.
   */
  function startResize(event: PointerEvent, span: IssueSpan, edge: 'start' | 'end'): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    resizing = { span, edge, day: span[edge] }
    window.addEventListener('pointermove', moveResize)
    window.addEventListener('pointerup', endResize)
    window.addEventListener('pointercancel', cancelResize)
  }

  /** Stops following the pointer for a stretch. */
  function stopFollowing(): void {
    window.removeEventListener('pointermove', moveResize)
    window.removeEventListener('pointerup', endResize)
    window.removeEventListener('pointercancel', cancelResize)
  }

  /** Drops a stretch without writing it. */
  function cancelResize(): void {
    stopFollowing()
    resizing = null
  }

  /** Follows the pointer to the day the dragged end is over. */
  function moveResize(event: PointerEvent): void {
    if (!resizing) return
    const day = dayAt(event.clientX, event.clientY)
    if (day === null) return
    resizing = { ...resizing, day }
  }

  /** Writes the stretched bar's dates, unless its end was let go where it started. */
  function endResize(): void {
    stopFollowing()
    const active = resizing
    resizing = null
    // The release ends in a click on whatever bar is under it, which is not a request to open it.
    swallowClick = true
    setTimeout(() => (swallowClick = false), 0)
    if (!active || active.day === active.span[active.edge]) return
    void setIssueDates(active.span.issue, resizedDates(active.span, range, active.edge, active.day))
  }

  /** Set for the click that ends a stretch. */
  let swallowClick = false

  /** Opens an issue, unless the click only ended a stretch. */
  function open(number: number): void {
    if (swallowClick) return
    onopen(number)
  }

  // A calendar closed mid-stretch leaves nothing listening on the window.
  $effect(() => stopFollowing)

  function isSelected(number: number): boolean {
    const selection = github.selection
    if (!selection) return false
    return selection.kind === 'issue' && selection.number === number
  }
</script>

{#snippet chip(issue: GithubIssueItem)}
  <button
    class="flex w-full min-w-0 cursor-pointer items-baseline gap-1 rounded border bg-surface px-1 py-0.5 text-left text-2xs hover:bg-hover"
    class:border-line={!isSelected(issue.number)}
    class:border-line-strong={isSelected(issue.number)}
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

{#snippet bar(piece: WeekBar)}
  {@const issue = piece.span.issue}
  {@const late = isOverdue(issue, piece.span.end, today)}
  {@const stretchable = range.end !== null}
  <div
    class="group relative flex min-w-0 cursor-pointer items-baseline gap-1 border-y px-1 py-0.5 text-2xs hover:bg-hover"
    class:border-line={!isSelected(issue.number) && !late}
    class:border-line-strong={isSelected(issue.number)}
    class:border-red={late && !isSelected(issue.number)}
    class:bg-surface={!late}
    class:bg-red-soft={late}
    class:rounded-l={piece.startsHere}
    class:border-l={piece.startsHere}
    class:ml-0.5={piece.startsHere}
    class:rounded-r={piece.endsHere}
    class:border-r={piece.endsHere}
    class:mr-0.5={piece.endsHere}
    style:grid-column="{piece.startColumn + 1} / {piece.endColumn + 2}"
    style:grid-row={piece.lane + 2}
    role="button"
    tabindex="0"
    draggable="true"
    title="#{issue.number} {issue.title}"
    ondragstart={(event) => startDrag(event, issue)}
    onmouseenter={() => prefetchItem('issue', issue.number)}
    onclick={() => open(issue.number)}
    onkeydown={(event) => {
      if (event.key === 'Enter') onopen(issue.number)
    }}
  >
    <span class="shrink-0 font-mono text-dim">#{issue.number}</span>
    <span class="truncate text-default">{issue.title}</span>
    {#if stretchable && piece.startsHere}
      <span
        class="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l group-hover:bg-line-strong"
        aria-hidden="true"
        onpointerdown={(event) => startResize(event, piece.span, 'start')}
        onclick={(event) => event.stopPropagation()}
      ></span>
    {/if}
    {#if stretchable && piece.endsHere}
      <span
        class="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r group-hover:bg-line-strong"
        aria-hidden="true"
        onpointerdown={(event) => startResize(event, piece.span, 'end')}
        onclick={(event) => event.stopPropagation()}
      ></span>
    {/if}
  </div>
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
        {#each weeks as week, weekIndex (week[0].date)}
          <!-- Days behind, bars over them in lanes under the day numbers. Drops
               land on the week and read the day from where across it they are,
               since a bar covers the days it spans. -->
          <div
            class="relative min-h-0 overflow-hidden border-b border-line last:border-b-0"
            data-week={weekIndex}
            role="group"
            aria-label="Week of {week[0].date}"
            ondragover={(event) => dragOverWeek(event, week)}
            ondragleave={dragLeave}
            ondrop={(event) => dropOnWeek(event, week)}
          >
            <div class="absolute inset-0 grid grid-cols-7">
              {#each week as day (day.date)}
                <div
                  class="border-r border-line last:border-r-0"
                  class:bg-canvas={!day.inMonth && dropTarget !== day.date}
                  class:bg-hover={dropTarget === day.date}
                ></div>
              {/each}
            </div>
            <div class="relative grid grid-cols-7 content-start gap-y-0.5 py-1">
              {#each week as day, column (day.date)}
                <span
                  class="mx-1 self-start justify-self-start rounded px-1 font-mono text-2xs"
                  class:text-dim={day.date !== today}
                  class:bg-action={day.date === today}
                  class:text-action-fg={day.date === today}
                  style:grid-column={column + 1}
                  style:grid-row={1}
                >
                  {day.dayOfMonth}
                </span>
              {/each}
              {#each weekBars(shownSpans, week) as piece (piece.span.issue.number)}
                {@render bar(piece)}
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>

    <section
      class="flex min-h-0 w-48 shrink-0 flex-col rounded-lg border bg-canvas"
      class:border-line={dropTarget !== UNDATED}
      class:border-line-strong={dropTarget === UNDATED}
      aria-label={undatedLabel}
      ondragover={dragOverUndated}
      ondragleave={dragLeave}
      ondrop={dropOnUndated}
    >
      <h3
        class="flex shrink-0 items-center gap-1.5 px-2 pb-1 pt-2 text-xs font-semibold text-muted"
      >
        {undatedLabel}
        <span class="font-mono text-2xs font-normal text-dim">{placed.undated.length}</span>
      </h3>
      <FloatingScrollbar class="min-h-0 flex-1">
        <div class="flex flex-col gap-1 p-1.5 pt-0.5">
          {#each placed.undated as issue (issue.number)}
            {@render chip(issue)}
          {/each}
        </div>
      </FloatingScrollbar>
    </section>
  </div>
</div>
