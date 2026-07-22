// terminals.* routes: PTYs owned by the creating client. Ownership is
// enforced on every call — a client can never write to, read from, or kill
// a terminal it didn't create (user terminals and other clients' terminals
// are invisible). Output is delivered via a per-terminal reader stream, not
// the EventHub, so terminal data can't leak across clients that merely hold
// the terminal.exec scope. All under 'terminal.exec' (danger tier).

import type { RouteRegistry } from '../registry'
import { ApiError } from '../registry'

export interface TerminalsRouteDeps {
  create: (options: {
    worktreeId: string
    cols?: number
    rows?: number
  }) => string
  write: (terminalId: string, data: string) => void
  resize: (terminalId: string, cols: number, rows: number) => void
  kill: (terminalId: string) => void
  // Surface the terminal to the user (visibility is the mitigation for the
  // danger scope): notification + log line labeled with the client.
  announce: (worktreeId: string, terminalId: string, clientName: string) => void
}

// TerminalManager events for API-owned terminals are fed in through this tap
// (the ipc layer forwards its TerminalEvents callbacks here).
export interface TerminalsTap {
  onData: (terminalId: string, data: string) => void
  onExit: (terminalId: string, exitCode: number) => void
}

interface OwnedTerminal {
  clientKey: string
  worktreeId: string
  // Chunks buffered until (and between) reader attachments, capped.
  backlog: { data: string }[]
  reader: ((chunk: unknown) => void) | null
  exitCode: number | null
  endReader: (() => void) | null
}

const BACKLOG_CAP = 1000

export function registerTerminalsRoutes(
  registry: RouteRegistry,
  deps: TerminalsRouteDeps
): TerminalsTap {
  const owned = new Map<string, OwnedTerminal>()

  function requireOwned(terminalId: unknown, clientKey: string): OwnedTerminal {
    const terminal = owned.get(String(terminalId ?? ''))
    if (!terminal || terminal.clientKey !== clientKey) {
      throw new ApiError('unknown terminal (clients only see terminals they created)', 'invalid')
    }
    return terminal
  }

  registry.register({
    method: 'terminals.create',
    scope: 'terminal.exec',
    describe: (args, context) => `open a terminal in ${context.worktreeFor(args).path}`,
    handler: async (args, context) => {
      const worktree = context.worktreeFor(args)
      const terminalId = deps.create({
        worktreeId: worktree.id,
        cols: optionalNumber(args.cols),
        rows: optionalNumber(args.rows)
      })
      owned.set(terminalId, {
        clientKey: context.client.key,
        worktreeId: worktree.id,
        backlog: [],
        reader: null,
        exitCode: null,
        endReader: null
      })
      deps.announce(worktree.id, terminalId, context.client.name)
      const command = args.command === undefined ? null : String(args.command)
      if (command) deps.write(terminalId, command + '\n')
      return { terminalId }
    }
  })

  registry.register({
    method: 'terminals.write',
    scope: 'terminal.exec',
    handler: async (args, context) => {
      requireOwned(args.terminalId, context.client.key)
      deps.write(String(args.terminalId), String(args.data ?? ''))
    }
  })

  registry.register({
    method: 'terminals.resize',
    scope: 'terminal.exec',
    handler: async (args, context) => {
      requireOwned(args.terminalId, context.client.key)
      deps.resize(String(args.terminalId), Number(args.cols) || 80, Number(args.rows) || 24)
    }
  })

  registry.register({
    method: 'terminals.kill',
    scope: 'terminal.exec',
    handler: async (args, context) => {
      requireOwned(args.terminalId, context.client.key)
      deps.kill(String(args.terminalId))
      owned.delete(String(args.terminalId))
    }
  })

  registry.register({
    method: 'terminals.read',
    scope: 'terminal.exec',
    streaming: true,
    handler: (args, context) => {
      const terminal = requireOwned(args.terminalId, context.client.key)
      return new Promise<null>((resolve) => {
        const flushBacklog = (): void => {
          if (terminal.backlog.length === 0) return
          context.emit(terminal.backlog)
          terminal.backlog = []
        }
        flushBacklog()
        if (terminal.exitCode !== null) {
          context.emit([{ exitCode: terminal.exitCode }])
          resolve(null)
          return
        }
        terminal.reader = (chunk) => context.emit([chunk])
        terminal.endReader = () => resolve(null)
        context.signal.addEventListener('abort', () => {
          terminal.reader = null
          terminal.endReader = null
          resolve(null)
        })
      })
    }
  })

  return {
    onData: (terminalId, data) => {
      const terminal = owned.get(terminalId)
      if (!terminal) return
      if (terminal.reader) {
        terminal.reader({ data })
        return
      }
      terminal.backlog.push({ data })
      if (terminal.backlog.length > BACKLOG_CAP) terminal.backlog.shift()
    },
    onExit: (terminalId, exitCode) => {
      const terminal = owned.get(terminalId)
      if (!terminal) return
      terminal.exitCode = exitCode
      if (terminal.reader) terminal.reader({ exitCode })
      terminal.endReader?.()
      terminal.reader = null
      terminal.endReader = null
    }
  }
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  return Number(value)
}
