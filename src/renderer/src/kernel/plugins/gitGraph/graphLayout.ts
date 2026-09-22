// Lays a commit list out as a graph: which column each commit sits in, and the
// lines each row draws. Commits come children first (`git log --date-order`),
// so the graph is built top to bottom by keeping, per column, the commit that
// column is waiting to reach. A row draws in two halves — the lines coming
// down into it from above, and the lines leaving it downwards — so every row
// can be drawn on its own, which is what lets the pane render only the rows on
// screen.

export interface GraphCommit {
  sha: string
  parents: string[]
}

// One line in half a row, from a column at the half's top edge to a column at
// its bottom edge. `colour` indexes the pane's lane palette.
export interface GraphLine {
  from: number
  to: number
  colour: number
}

export interface GraphRow {
  column: number
  colour: number
  // Lines from the row's top edge down to its middle, where the commit is.
  above: GraphLine[]
  // Lines from the middle down to the row's bottom edge.
  below: GraphLine[]
}

export interface GraphLayout {
  rows: GraphRow[]
  // The most columns any row uses.
  columns: number
}

// A column's line, waiting for the commit it leads to.
interface Lane {
  sha: string
  colour: number
}

type Lanes = Array<Lane | null>

/** Lays the commits out, one row per commit, in the order given. */
export function layoutGraph(commits: GraphCommit[]): GraphLayout {
  const lanes: Lanes = []
  const rows: GraphRow[] = []
  const palette = { next: 0 }
  let columns = 0

  for (const commit of commits) {
    const row = layoutRow(commit, lanes, palette)
    rows.push(row)
    columns = Math.max(columns, widest(row))
  }
  return { rows, columns }
}

/** Places one commit, updating the lanes to what the rows below it wait for. */
function layoutRow(commit: GraphCommit, lanes: Lanes, palette: { next: number }): GraphRow {
  let column = lanes.findIndex((lane) => lane !== null && lane.sha === commit.sha)
  let colour: number
  if (column === -1) {
    // Nothing above leads here: the tip of a branch starts a new line.
    column = freeColumn(lanes, -1)
    if (column === lanes.length) lanes.push(null)
    colour = palette.next++
  } else {
    colour = (lanes[column] as Lane).colour
  }

  const above = linesInto(commit.sha, column, lanes)
  for (let index = 0; index < lanes.length; index++) {
    if (lanes[index]?.sha === commit.sha) lanes[index] = null
  }

  const started = new Set<number>()
  const below: GraphLine[] = []
  commit.parents.forEach((parent, parentIndex) => {
    const target = laneForParent(parent, parentIndex, column, colour, lanes, palette)
    if (target.started) started.add(target.column)
    below.push({ from: column, to: target.column, colour: (lanes[target.column] as Lane).colour })
  })
  for (let index = 0; index < lanes.length; index++) {
    const lane = lanes[index]
    if (lane === null || started.has(index)) continue
    below.push({ from: index, to: index, colour: lane.colour })
  }

  trimTrailing(lanes)
  return { column, colour, above, below }
}

/** The lines coming down from the row above: into the commit, or straight past it. */
function linesInto(sha: string, column: number, lanes: Lanes): GraphLine[] {
  const lines: GraphLine[] = []
  lanes.forEach((lane, index) => {
    if (lane === null) return
    let to = index
    if (lane.sha === sha) to = column
    lines.push({ from: index, to, colour: lane.colour })
  })
  return lines
}

/**
 * The column a parent's line continues in. The first parent carries on in the
 * commit's own column and colour, unless a column to its left already waits
 * for it — then the line bends over and joins it. Two columns waiting for the
 * same commit are fine: both lines come in when it is reached, which keeps a
 * branch's own line straight rather than jumping right. Any other parent
 * joins a column already waiting for it, or opens one of its own.
 */
function laneForParent(
  parent: string,
  parentIndex: number,
  column: number,
  colour: number,
  lanes: Lanes,
  palette: { next: number }
): { column: number; started: boolean } {
  const existing = lanes.findIndex((lane) => lane !== null && lane.sha === parent)
  const joinsExisting = existing !== -1 && (parentIndex > 0 || existing < column)
  if (joinsExisting) return { column: existing, started: false }
  if (parentIndex === 0) {
    lanes[column] = { sha: parent, colour }
    return { column, started: true }
  }
  const free = freeColumn(lanes, column)
  lanes[free] = { sha: parent, colour: palette.next++ }
  return { column: free, started: true }
}

/** The leftmost empty column other than `taken`, or a new one on the right. */
function freeColumn(lanes: Lanes, taken: number): number {
  for (let index = 0; index < lanes.length; index++) {
    if (lanes[index] === null && index !== taken) return index
  }
  return lanes.length
}

/** Drops empty columns off the right, so the graph narrows once branches end. */
function trimTrailing(lanes: Lanes): void {
  while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
}

/** How many columns a row reaches across. */
function widest(row: GraphRow): number {
  let columns = row.column + 1
  for (const line of [...row.above, ...row.below]) {
    columns = Math.max(columns, line.from + 1, line.to + 1)
  }
  return columns
}
