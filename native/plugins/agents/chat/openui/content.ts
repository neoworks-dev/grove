// Small decisions of the content components. Plain functions, tested without a window.
import { cellText, type Cell } from "./props";

/** What stands next to a progress bar: its percentage, and the label unless it says the percentage. */
export function progressLabel(value: number, label: string | undefined): string {
  const percent = `${Math.round(value * 100)}%`;
  const said = label === undefined ? null : label.match(/(\d+(?:\.\d+)?)\s*%/);
  if (label === undefined || label === "") return percent;
  if (said?.[1] !== undefined && Math.round(Number(said[1])) === Math.round(value * 100)) {
    return label;
  }
  return `${percent} ${label}`;
}

const NUMERIC = /^[-+]?[\d.,]+\s*(%|[a-zA-Z]{0,3})?$/;

/** Whether a cell is a number: it lines up on the right. */
export function isNumeric(cell: Cell): boolean {
  if (typeof cell !== "string") return false;
  return cell.trim() !== "" && NUMERIC.test(cell.trim()) && /\d/.test(cell);
}

/** A column is a number column when all its cells are numbers. */
export function numericColumns(columns: number, rows: readonly (readonly Cell[])[]): boolean[] {
  return Array.from({ length: columns }, (_, column) => {
    const cells = rows.map((row) => row[column]).filter((cell) => cell !== undefined);
    return cells.length > 0 && cells.every(isNumeric);
  });
}

/** Relative widths of a table's columns: wide content gets more room, but none takes over. */
export function tableWeights(
  columns: readonly string[],
  rows: readonly (readonly Cell[])[],
): number[] {
  const count = Math.max(columns.length, ...rows.map((row) => row.length));
  return Array.from({ length: count }, (_, column) => {
    const cells = [columns[column] ?? "", ...rows.map((row) => cellText(row[column] ?? ""))];
    const longest = Math.max(...cells.map((cell) => cell.length));
    return Math.min(40, Math.max(5, longest));
  });
}

/** The marker of a list's n-th item. */
export function marker(ordered: boolean, index: number): string {
  return ordered ? `${index + 1}.` : "•";
}
