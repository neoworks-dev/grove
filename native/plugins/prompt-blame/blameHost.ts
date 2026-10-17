// What prompt blame asks the sidecar: Grove's own `blame:line` route, which finds the commit that
// last changed a line and the agent prompt that wrote it. Kept apart from the service so the
// service runs under `bun test` with a fake.

import type { LineBlame } from "../../../src/shared/agents";
import type { SidecarService } from "../sidecar/service";

/** The question about a line that the prompt records answer. */
export interface PromptBlameHost {
  /** The commit and prompt behind a line, counted from 1, which currently reads `text`. */
  blameLine(worktreeId: string, path: string, line: number, text: string): Promise<LineBlame>;
}

/** Prompt blame as the sidecar answers it. */
export function sidecarBlameHost(sidecar: SidecarService): PromptBlameHost {
  return {
    blameLine: (worktreeId, path, line, text) => sidecar.workbench.blame.line(worktreeId, path, line, text),
  };
}
