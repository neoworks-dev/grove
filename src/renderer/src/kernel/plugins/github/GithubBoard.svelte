<script lang="ts">
  // The issues of the list, as a board: one column per option of the chosen
  // issue field, plus one for issues the field is not set on. Dropping a card on
  // a column sets the field on GitHub.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import GithubBoardCard from './GithubBoardCard.svelte'
  import { boardColumns, optionColour, optionOf, type BoardColumn } from './board'
  import { github, moveIssueOnBoard } from './store.svelte'
  import type { GithubIssueField, GithubIssueItem } from '../../../../../shared/types'

  let {
    field,
    onopen
  }: {
    field: GithubIssueField
    onopen: (number: number) => void
  } = $props()

  const DRAG_TYPE = 'application/x-grove-issue'

  const issues = $derived(
    github.items.filter((item): item is GithubIssueItem => item.kind === 'issue')
  )
  const columns = $derived(boardColumns(issues, field))

  /** The column a card is being dragged over, so it can show it will take the drop. */
  let dropTarget = $state<string | null>(null)

  /** A column's key for `dropTarget`; the unset column has no option id of its own. */
  function keyOf(column: BoardColumn): string {
    if (column.optionId === null) return 'unset'
    return column.optionId
  }

  /** Accepts an issue being dragged over a column, and nothing else. */
  function dragOver(event: DragEvent, column: BoardColumn): void {
    if (!event.dataTransfer || !event.dataTransfer.types.includes(DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    dropTarget = keyOf(column)
  }

  /** Forgets the highlight once the pointer leaves the column itself, not a card inside it. */
  function dragLeave(event: DragEvent, column: BoardColumn): void {
    const into = event.relatedTarget
    if (into instanceof Node && (event.currentTarget as HTMLElement).contains(into)) return
    if (dropTarget === keyOf(column)) dropTarget = null
  }

  /** Moves the dropped issue into the column, unless it is already there. */
  function drop(event: DragEvent, column: BoardColumn): void {
    dropTarget = null
    if (!event.dataTransfer) return
    event.preventDefault()
    const number = Number(event.dataTransfer.getData(DRAG_TYPE))
    const issue = issues.find((candidate) => candidate.number === number)
    if (!issue) return
    if (optionOf(issue, field.id) === column.optionId) return
    void moveIssueOnBoard(issue, column.optionId)
  }

  function isSelected(number: number): boolean {
    const selection = github.selection
    if (!selection) return false
    return selection.kind === 'issue' && selection.number === number
  }
</script>

<div class="flex min-h-0 flex-1 gap-2 overflow-x-auto p-2">
  {#each columns as column (keyOf(column))}
    <section
      class="flex min-h-0 w-64 shrink-0 flex-col rounded-lg border"
      class:border-line={dropTarget !== keyOf(column)}
      class:border-line-strong={dropTarget === keyOf(column)}
      class:bg-hover={dropTarget === keyOf(column)}
      aria-label={column.name}
      ondragover={(event) => dragOver(event, column)}
      ondragleave={(event) => dragLeave(event, column)}
      ondrop={(event) => drop(event, column)}
    >
      <h3
        class="flex shrink-0 items-center gap-1.5 px-2 pb-1 pt-2 text-xs font-semibold text-muted"
      >
        <span class="size-2 rounded-full" style:background={optionColour(column.color)}></span>
        {column.name}
        <span class="font-mono text-2xs font-normal text-dim">{column.issues.length}</span>
      </h3>
      <FloatingScrollbar class="min-h-0 flex-1">
        <div class="flex flex-col gap-1.5 p-1.5 pt-0.5">
          {#each column.issues as issue (issue.number)}
            <GithubBoardCard
              {issue}
              selected={isSelected(issue.number)}
              onopen={() => onopen(issue.number)}
            />
          {/each}
        </div>
      </FloatingScrollbar>
    </section>
  {/each}
</div>
