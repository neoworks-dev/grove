// The slash commands the `/` menu lists, and how what is typed picks among them. Plain
// functions, so they are tested without a window. The daemon answers every command itself (`/model`
// opens a choice card), so the menu only helps type them. Ported from neoworks-harness apps/gui
// (lib/commands.ts).

export interface SlashCommand {
  name: string;
  /** Argument hint shown after the name. */
  args: string;
  desc: string;
  /** Pointless without arguments: Enter completes it instead of sending it. */
  needsArgs: boolean;
}

/** A command the daemon answers. */
function daemonCommand(name: string, args: string, desc: string, needsArgs = false): SlashCommand {
  return { name, args, desc, needsArgs };
}

/** The commands the daemon answers. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  daemonCommand("clear", "", "start a new conversation in this directory"),
  daemonCommand("model", "[harness] [model]", "show or set the model"),
  daemonCommand("effort", "[harness] [level]", "show or set the reasoning effort"),
  daemonCommand("mode", "[harness] [mode]", "show or set the agent mode"),
  daemonCommand("resume", "[claude|codex]", "continue an earlier Claude Code / Codex conversation"),
  daemonCommand("claude", "<task>", "give a task to Claude Code", true),
  daemonCommand("codex", "<task>", "give a task to Codex", true),
  daemonCommand("harness", "[pi|claude|codex]", "switch this session's agent: pi, claude, codex"),
  daemonCommand("approvals", "[ask|review|edits|auto]", "ask, review each edit, accept edits, or auto (no value: next)"),
];

/** Whether the text is a command being typed: a slash, and no space or newline yet. */
export function isSlashWord(text: string): boolean {
  return text.startsWith("/") && !/\s/.test(text);
}

/**
 * The commands for what is typed after the slash: names starting with it, else (when none does)
 * names containing it.
 */
export function matchingCommands(typed: string, commands: readonly SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  let query = typed;
  if (typed.startsWith("/")) {
    query = typed.slice(1);
  }
  query = query.toLowerCase();
  const starting = commands.filter((command) => command.name.startsWith(query));
  if (starting.length > 0) {
    return starting;
  }
  return commands.filter((command) => command.name.includes(query));
}

/** What Tab or Enter puts in the input for a menu pick: the name and a space for arguments. */
export function completion(command: SlashCommand): string {
  return `/${command.name} `;
}

/** The highlighted row after moving by `delta`, wrapping around `count` rows. */
export function moveSelection(selected: number, delta: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return (((selected + delta) % count) + count) % count;
}
