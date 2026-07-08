// Command registry for the F1 command palette. Commands are contributed by any
// part of the app (and, later, plugins) — nothing here is hardcoded to a
// feature. Register on mount, unregister on destroy.

export interface Command {
  id: string
  title: string
  group?: string
  keywords?: string
  run: () => void | Promise<void>
}

class CommandRegistry {
  commands = $state<Command[]>([])
  paletteOpen = $state(false)

  // Register (or replace by id) a command. Returns an unregister function.
  register(command: Command): () => void {
    const existing = this.commands.findIndex((entry) => entry.id === command.id)
    if (existing >= 0) {
      this.commands = this.commands.map((entry) =>
        entry.id === command.id ? command : entry
      )
    } else {
      this.commands = [...this.commands, command]
    }
    return () => this.unregister(command.id)
  }

  // Register several commands at once. Returns one unregister for the batch.
  registerAll(commands: Command[]): () => void {
    const disposers = commands.map((command) => this.register(command))
    return () => disposers.forEach((dispose) => dispose())
  }

  unregister(id: string): void {
    this.commands = this.commands.filter((entry) => entry.id !== id)
  }

  open(): void {
    this.paletteOpen = true
  }

  close(): void {
    this.paletteOpen = false
  }

  toggle(): void {
    this.paletteOpen = !this.paletteOpen
  }
}

export const commands = new CommandRegistry()
