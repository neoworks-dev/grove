// The tools Grove offers the daemon's agents, which the buttons of its neoui components call
// (`hx-post="grove.openFile"`). The agents plugin answers them through the editor service.

import type { AppTool } from "./contributions";

/** What the open-file tool needs of the agents service. */
export interface FileRevealer {
  /** The absolute path a tool call names; throws when a relative one has nothing to be taken from. */
  resolvePath(path: string): string;
  /** Shows the file in the editor with the cursor on a line, counted from one. */
  revealFile(path: string, line: number): Promise<void>;
}

/** The tools of Grove: `grove.openFile`. */
export function groveTools(files: FileRevealer): AppTool[] {
  return [openFileTool(files)];
}

/** `grove.openFile`: shows a file in Grove's editor, at a line when one is given. */
function openFileTool(files: FileRevealer): AppTool {
  return {
    name: "openFile",
    description:
      "Shows a file in Grove's editor and puts the cursor on a line. The path is absolute or relative to the shown worktree; the line is counted from 1 and defaults to the first.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute, or relative to the shown worktree" },
        line: { type: "number", description: "Line to put the cursor on, from 1" },
      },
      required: ["path"],
    },
    async run(args) {
      const path = args["path"];
      if (typeof path !== "string" || path === "") {
        throw new Error("openFile needs a path");
      }
      const absolute = files.resolvePath(path);
      const line = lineOf(args["line"]);
      await files.revealFile(absolute, line);
      return `Opened ${absolute} at line ${line}`;
    },
  };
}

/** The line a call asks for: a whole number from 1, or 1 when it names none. */
function lineOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.floor(value);
}
