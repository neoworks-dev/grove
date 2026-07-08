// Command registry for the F1 command palette. Commands are contributed by any
// part of the app (and plugins) — nothing here is hardcoded to a feature.
// Register on mount, unregister on destroy. The palette itself is an instance
// of the canonical overlay.

import { overlays, matchesQuery, type OverlayItem } from './overlays.svelte'

export interface Command {
  id: string
  title: string
  group?: string
  keywords?: string
  run: () => void | Promise<void>
}

const PALETTE_OVERLAY_ID = 'commands'

class CommandRegistry {
  commands = $state<Command[]>([])

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
    overlays.show({
      id: PALETTE_OVERLAY_ID,
      placeholder: 'Type a command…',
      debounceMs: 0,
      onQuery: (query, emit) => {
        const items: OverlayItem[] = this.commands
          .filter((command) =>
            matchesQuery(`${command.title} ${command.group || ''} ${command.keywords || ''}`, query)
          )
          .map((command) => ({ id: command.id, label: command.title, detail: command.group }))
        emit(items, { replace: true })
      },
      onAccept: (picked) => {
        const command = this.commands.find((entry) => entry.id === picked[0]?.id)
        if (command) void command.run()
      }
    })
  }

  close(): void {
    if (overlays.isOpen(PALETTE_OVERLAY_ID)) overlays.cancel()
  }

  toggle(): void {
    if (overlays.isOpen(PALETTE_OVERLAY_ID)) {
      overlays.cancel()
      return
    }
    this.open()
  }
}

export const commands = new CommandRegistry()
