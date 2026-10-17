// Column shares for a table component: wide content gets more room, but no column takes over.
import type { TableComponent } from "@suite/protocol/types";

const NARROWEST = 4;
const WIDEST = 40;

/** One relative width per column, from the longest cell (header included), kept in 4..40. */
export function columnWeights(table: TableComponent): number[] {
  const count = Math.max(table.columns.length, ...table.rows.map((row) => row.length));
  return Array.from({ length: count }, (_, column) => {
    const cells = [table.columns[column] ?? "", ...table.rows.map((row) => row[column] ?? "")];
    const longest = Math.max(...cells.map((cell) => cell.length));
    return Math.min(WIDEST, Math.max(NARROWEST, longest));
  });
}
