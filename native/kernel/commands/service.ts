// The `commands` service: things the app can do, by id, for key bindings, menus and the
// palette to run. Ported from Grove's command registry, without the palette overlay, which
// is a shell component. A registration is tracked on the calling plugin's fiber, so
// unloading the plugin unregisters its commands.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../reactive";

declare module "@neoworks/extension-system" {
  interface Context {
    commands: CommandsService;
  }
}

export interface Command {
  id: string;
  title: string;
  group?: string;
  keywords?: string;
  /** Whether the command can run now; a command that cannot is skipped by `run`. */
  when?: () => boolean;
  run: (...args: unknown[]) => void | Promise<void>;
}

export class CommandsService extends Service {
  private commandsById = new Map<string, Command>();
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context) {
    super(ctx, "commands");
  }

  /**
   * Registers a command, replacing one with the same id with a warning. It is removed with the
   * calling plugin, or when the returned function is called, unless another has replaced it since.
   */
  register(command: Command): () => void {
    return this.ctx.effect(() => {
      if (this.commandsById.has(command.id)) {
        this.ctx.logger.warn(`command "${command.id}" is registered twice; the later one wins`);
      }
      this.commandsById.set(command.id, command);
      this.changes.notify();
      return () => {
        if (this.commandsById.get(command.id) !== command) {
          return;
        }
        this.commandsById.delete(command.id);
        this.changes.notify();
      };
    }, `commands.register(${command.id})`);
  }

  /** Whether a command with this id exists and its `when` allows it now. */
  canRun(id: string): boolean {
    const command = this.commandsById.get(id);
    if (!command) {
      return false;
    }
    if (command.when && !command.when()) {
      return false;
    }
    return true;
  }

  /** The command with this id, or undefined. Reactive. */
  get(id: string): Command | undefined {
    this.changes.track();
    return this.commandsById.get(id);
  }

  /** Every registered command, in registration order. Reactive. */
  list(): Command[] {
    this.changes.track();
    return [...this.commandsById.values()];
  }

  /**
   * Runs a command by id. Resolves to false when there is no such command, its `when` says no,
   * or it throws; a throw is logged, not rethrown, so one broken command cannot break a key press.
   */
  async run(id: string, ...args: unknown[]): Promise<boolean> {
    const command = this.commandsById.get(id);
    if (!command) {
      this.ctx.logger.warn(`no command "${id}"`);
      return false;
    }
    if (!this.canRun(id)) {
      return false;
    }
    try {
      await command.run(...args);
    } catch (error) {
      this.ctx.logger.error(error);
      return false;
    }
    return true;
  }
}
