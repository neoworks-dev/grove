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
  /** The pane handles it itself instead of sending it to the daemon. */
  local: boolean;
}

/** A command the harness lists for itself, as `commands_available` carries it. */
export interface OfferedCommand {
  name: string;
  description?: string;
  hint?: string;
}

/** A command the daemon answers. */
function daemonCommand(name: string, args: string, desc: string, needsArgs = false): SlashCommand {
  return { name, args, desc, needsArgs, local: false };
}

/** The commands the daemon answers, then the ones the pane runs itself. Term's list (apps/term menu.rs), minus what Grove has no use for. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  daemonCommand("clear", "", "start a new conversation in this directory"),
  daemonCommand("cd", "[dir]", "move this session to another directory"),
  daemonCommand("model", "[harness] [model]", "show or set the model"),
  daemonCommand("effort", "[harness] [level]", "show or set the reasoning effort"),
  daemonCommand("mode", "[harness] [mode]", "show or set the agent mode"),
  daemonCommand("resume", "[claude|codex]", "continue an earlier Claude Code / Codex conversation"),
  daemonCommand("claude", "<task>", "give a task to Claude Code", true),
  daemonCommand("codex", "<task>", "give a task to Codex", true),
  daemonCommand("harness", "[neo|claude|codex]", "switch this session's agent: neo (based on pi), claude, codex"),
  daemonCommand("approvals", "[ask|review|edits|auto]", "ask, review each edit, accept edits, or auto (no value: next)"),
  daemonCommand("safesearch", "[strict|moderate|off]", "how much adult content web search may return"),
  daemonCommand("settings", "[toggle [on|off]]", "turn settings on or off, like Show, don't tell. (UI over text)"),
  daemonCommand("login", "[provider]", "add an API key or an account (ChatGPT, Copilot, Claude Pro/Max)"),
  daemonCommand("logout", "[provider]", "remove a stored API key or account"),
  daemonCommand("accounts", "", "list the API keys and accounts in use"),
  daemonCommand("plugin", "[install|enable|…]", "plugins for neo: list, search, install, uninstall, enable, disable, marketplace add"),
  { name: "help", args: "", desc: "keys and commands", needsArgs: false, local: true },
  {
    name: "todo",
    args: "<what to do>",
    desc: "add to the session's shared todo list (the agents see it too)",
    needsArgs: true,
    local: true,
  },
];

/**
 * The whole menu while the session runs on a harness that lists `offered`: ours, then the
 * harness's. A harness command named like one of ours is left out and ours says so, because the
 * daemon answers ours and the harness never sees them.
 */
export function commandsFor(
  harness: string,
  offered: readonly OfferedCommand[],
  own: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const commands = own.map((command) => ({ ...command }));
  for (const offer of offered) {
    const ours = commands.find((command) => command.name === offer.name);
    if (ours !== undefined) {
      ours.desc = `${ours.desc} (replaces ${harness}'s /${offer.name})`;
      continue;
    }
    let args = "";
    if (offer.hint !== undefined) {
      args = offer.hint;
    }
    let desc = "";
    if (offer.description !== undefined) {
      desc = offer.description;
    }
    commands.push({ name: offer.name, args, desc, needsArgs: false, local: false });
  }
  return commands;
}

/** The command a typed text names by its first word, among `commands`, or undefined. */
export function lookupCommand(text: string, commands: readonly SlashCommand[]): SlashCommand | undefined {
  const match = /^\s*\/(\S+)/.exec(text);
  if (match === null) {
    return undefined;
  }
  return commands.find((command) => command.name === match[1]);
}

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
