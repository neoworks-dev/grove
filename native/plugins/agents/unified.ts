// A unified diff (`git diff`) as the `DiffLine`s the diff view draws. Several files become
// several parts, each with its path. Ported from neoworks-harness apps/gui (lib/unified.ts).

import type { DiffLine } from "@suite/protocol/types";

export interface FileDiff {
  /** The new path (the old one for a deletion). */
  path: string;
  lines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The path on a `---` or `+++` line, without the `a/` or `b/` prefix; undefined for `/dev/null`. */
function pathOf(line: string, prefix: "---" | "+++"): string | undefined {
  const raw = line.slice(prefix.length).trim().replace(/\t.*$/, "");
  if (raw === "/dev/null") {
    return undefined;
  }
  return raw.replace(/^[ab]\//, "");
}

/** The state of the parse: the file and hunk being read and the next line numbers. */
interface Cursor {
  file: FileDiff | undefined;
  inHunk: boolean;
  oldNumber: number;
  newNumber: number;
  oldPath: string | undefined;
}

/** Splits a unified diff into files and numbers the lines of each hunk. Anything unknown is skipped. */
export function parseUnified(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const cursor: Cursor = { file: undefined, inHunk: false, oldNumber: 0, newNumber: 0, oldPath: undefined };
  const lines = text.split("\n");
  // The newline ending the last line is not an empty context line.
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  for (const line of lines) {
    readLine(line, cursor, files);
  }
  return files.filter((file) => file.lines.length > 0);
}

/** Takes one line of the diff into the cursor and the files. */
function readLine(line: string, cursor: Cursor, files: FileDiff[]): void {
  if (line.startsWith("diff --git ")) {
    const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
    let path = "";
    if (match !== null) {
      path = match[2];
    }
    cursor.file = { path, lines: [] };
    files.push(cursor.file);
    cursor.inHunk = false;
    cursor.oldPath = undefined;
    return;
  }
  if (!cursor.inHunk && line.startsWith("--- ")) {
    cursor.oldPath = pathOf(line, "---");
    if (cursor.file !== undefined && cursor.file.path === "" && cursor.oldPath !== undefined) {
      cursor.file.path = cursor.oldPath;
    }
    return;
  }
  if (!cursor.inHunk && line.startsWith("+++ ")) {
    readNewPath(line, cursor, files);
    return;
  }
  const hunk = HUNK_HEADER.exec(line);
  if (hunk !== null) {
    if (cursor.file === undefined) {
      cursor.file = { path: "", lines: [] };
      files.push(cursor.file);
    }
    cursor.oldNumber = Number(hunk[1]);
    cursor.newNumber = Number(hunk[2]);
    cursor.inHunk = true;
    cursor.file.lines.push({ kind: "hunk", text: line });
    return;
  }
  if (cursor.file !== undefined && cursor.inHunk) {
    readBodyLine(line, cursor.file, cursor);
  }
}

/** A `+++` line: the file's new path, which starts the file when no `diff --git` line did. */
function readNewPath(line: string, cursor: Cursor, files: FileDiff[]): void {
  const path = pathOf(line, "+++");
  if (cursor.file === undefined) {
    let chosen = "";
    if (path !== undefined) {
      chosen = path;
    } else if (cursor.oldPath !== undefined) {
      chosen = cursor.oldPath;
    }
    cursor.file = { path: chosen, lines: [] };
    files.push(cursor.file);
    return;
  }
  if (path !== undefined) {
    cursor.file.path = path;
  }
}

/** A line inside a hunk: an addition, a removal or context. */
function readBodyLine(line: string, file: FileDiff, cursor: Cursor): void {
  if (line.startsWith("+")) {
    file.lines.push({ kind: "add", text: line.slice(1), new: cursor.newNumber });
    cursor.newNumber += 1;
    return;
  }
  if (line.startsWith("-")) {
    file.lines.push({ kind: "remove", text: line.slice(1), old: cursor.oldNumber });
    cursor.oldNumber += 1;
    return;
  }
  // Some tools strip the space of an empty context line. "\ No newline at end of file" carries nothing.
  if (line.startsWith(" ") || line === "") {
    file.lines.push({ kind: "context", text: line.slice(1), old: cursor.oldNumber, new: cursor.newNumber });
    cursor.oldNumber += 1;
    cursor.newNumber += 1;
  }
}
