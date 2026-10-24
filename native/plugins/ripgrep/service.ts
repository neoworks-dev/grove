// The `ripgrep` service: the project's files and a search of their text, both by ripgrep so
// `.gitignore` is respected. The host runs `rg` (see `src/ripgrep.rs`) and stops the run a new
// one replaces, so asking again for every keystroke is cheap. Answers carry a failure instead of
// throwing, so a missing ripgrep reaches the picker as a sentence.

import { Service, type Context } from "@neoworks/extension-system";
import {
  MAX_FILES,
  MAX_MATCHES,
  contentArguments,
  fileListArguments,
  parseMatches,
  type ContentMatch,
} from "./parse";

declare module "@neoworks/extension-system" {
  interface Context {
    ripgrep: RipgrepService;
  }
}

/** Why ripgrep gave nothing: it is not installed, or it ran and failed. */
export interface RipgrepFailure {
  kind: "missing" | "failed";
  message: string;
}

/** What `ripgrep_run` answers with. */
export interface RipgrepAnswer {
  lines: string[];
  truncated: boolean;
  /** A newer run with the same key replaced this one, so its output is partial. */
  cancelled: boolean;
  error: RipgrepFailure | null;
}

/** One call to the host. A test supplies a fake. */
export type RipgrepRunner = (request: {
  key: string;
  cwd: string;
  args: string[];
  limit: number;
  count: "lines" | "matches";
}) => Promise<RipgrepAnswer>;

export interface FileListing {
  /** Paths relative to the directory listed. */
  files: string[];
  truncated: boolean;
  cancelled: boolean;
  failure: RipgrepFailure | null;
}

export interface ContentSearch {
  matches: ContentMatch[];
  truncated: boolean;
  cancelled: boolean;
  failure: RipgrepFailure | null;
}

export class RipgrepService extends Service {
  static inject = ["workspace"];

  constructor(
    ctx: Context,
    private run: RipgrepRunner,
  ) {
    super(ctx, "ripgrep");
  }

  /** The directory the pickers search: the worktree the workspace shows, else its repository. Null when none is open. */
  root(): string | null {
    const worktree = this.ctx.workspace.selectedWorktree();
    if (worktree !== null) {
      return worktree.path;
    }
    const repo = this.ctx.workspace.repo();
    if (repo !== null) {
      return repo.path;
    }
    return null;
  }

  /** Every file below `directory`, relative to it. */
  async listFiles(directory: string): Promise<FileListing> {
    const answer = await this.call("files", directory, fileListArguments(), MAX_FILES, "lines");
    return {
      files: answer.lines,
      truncated: answer.truncated,
      cancelled: answer.cancelled,
      failure: answer.error,
    };
  }

  /** The lines below `directory` that contain `query`. A search replaces the one before it. */
  async searchContent(directory: string, query: string): Promise<ContentSearch> {
    const answer = await this.call("content", directory, contentArguments(query), MAX_MATCHES, "matches");
    return {
      matches: parseMatches(answer.lines),
      truncated: answer.truncated,
      cancelled: answer.cancelled,
      failure: answer.error,
    };
  }

  /** Runs ripgrep, turning a host that cannot be reached into a failure. */
  private async call(
    key: string,
    cwd: string,
    args: string[],
    limit: number,
    count: "lines" | "matches",
  ): Promise<RipgrepAnswer> {
    try {
      return await this.run({ key, cwd, args, limit, count });
    } catch (error) {
      const message = String(error);
      return { lines: [], truncated: false, cancelled: false, error: { kind: "failed", message } };
    }
  }
}
