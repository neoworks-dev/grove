// The tools Grove offers the daemon's agents, which the buttons of its neoui components call
// (`hx-post="grove.openFile"`). The agents plugin answers them through the editor service and
// the GitHub plugin.

import type { AppTool } from "./contributions";
import type { GithubItemRequest } from "./service";

/** What the open-file tool needs of the agents service. */
export interface FileRevealer {
  /** The absolute path a tool call names; throws when a relative one has nothing to be taken from. */
  resolvePath(path: string): string;
  /** Shows the file in the editor with the cursor on a line, counted from one. */
  revealFile(path: string, line: number): Promise<void>;
}

/** What the open-issue tool needs of the agents service. */
export interface GithubItemOpener {
  /** Shows an issue or a pull request in a GitHub pane; false when the app has none or it could not be made. */
  openGithubItem(request: GithubItemRequest): Promise<boolean>;
}

/** The tools of Grove: `grove.openFile` and `grove.openIssue`. */
export function groveTools(files: FileRevealer & GithubItemOpener): AppTool[] {
  return [openFileTool(files), openIssueTool(files)];
}

/** A repository named `owner/name`. */
const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** `grove.openIssue`: shows an issue or a pull request in Grove's GitHub pane. */
function openIssueTool(github: GithubItemOpener): AppTool {
  return {
    name: "openIssue",
    description:
      "Shows a GitHub issue or pull request in Grove's GitHub pane, with its comments and, for a pull request, its checks, reviews and changed files. The repository is owner/name; kind is issue or pull, and when it is left out Grove looks it up.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "The repository as owner/name" },
        number: { type: "number", description: "The issue or pull request number" },
        kind: { type: "string", enum: ["issue", "pull"], description: "Whether it is an issue or a pull request" },
      },
      required: ["repo", "number"],
    },
    async run(args) {
      const request = itemRequestOf(args);
      if (!(await github.openGithubItem(request))) {
        throw new Error("Grove has no GitHub pane to show it in");
      }
      return `Opened ${describeItem(request)} in Grove`;
    },
  };
}

/** The item a call names, or an error that says what is wrong with it. */
function itemRequestOf(args: Record<string, unknown>): GithubItemRequest {
  const repo = args["repo"];
  if (typeof repo !== "string" || !REPOSITORY_PATTERN.test(repo)) {
    throw new Error("openIssue needs a repo written owner/name");
  }
  const number = args["number"];
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    throw new Error("openIssue needs the number of an issue or pull request");
  }
  return { repo, number, kind: kindOf(args["kind"]) };
}

/** The kind a call names: issue or pull, or null for one it leaves out, which is looked up. */
function kindOf(value: unknown): "issue" | "pull" | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (value === "issue" || value === "pull") {
    return value;
  }
  throw new Error("openIssue takes a kind of issue or pull");
}

/** The words for an item in the tool's answer. */
function describeItem(request: GithubItemRequest): string {
  if (request.kind === "pull") {
    return `pull request ${request.repo}#${request.number}`;
  }
  if (request.kind === "issue") {
    return `issue ${request.repo}#${request.number}`;
  }
  return `${request.repo}#${request.number}`;
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
