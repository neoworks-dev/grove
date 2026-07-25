// Rewrites hardcoded ports in a detected command to Grove's ${PORT_0} placeholder.
//
// Every worktree gets its own port block, so a command with a literal port would
// make two worktrees fight over the same socket. Detected commands almost always
// carry one (`vite --port 5173`, `PORT=3000 node server.js`), so substituting it
// is what makes a detected service usable in parallel at all.

export const PORT_PLACEHOLDER = '${PORT_0}'

// How a command names its port. The caller needs this distinction: a flag has to
// be overridden with the same flag, while an env assignment is overridden by
// re-exporting the variable.
export type PortStyle = 'flag' | 'env' | 'none'

// Ordered most- to least-specific: `--port=3000` must win over a bare `:3000`
// inside the same string, and an env assignment must not be mistaken for a flag.
const PORT_PATTERNS: Array<{ pattern: RegExp; style: PortStyle }> = [
  { pattern: /(--port[= ])(\d{2,5})\b/, style: 'flag' },
  { pattern: /(--listen[= ])(\d{2,5})\b/, style: 'flag' },
  { pattern: /(-p[= ])(\d{2,5})\b/, style: 'flag' },
  { pattern: /\b(PORT=)(\d{2,5})\b/, style: 'env' },
  { pattern: /(:)(\d{4,5})\b/, style: 'flag' }
]

export interface PortRewrite {
  // The command with its first literal port replaced. Equal to the input when
  // nothing was found.
  command: string
  style: PortStyle
  // The literal port that was replaced, for telling the user what changed.
  originalPort: number | null
}

// Replaces the first hardcoded port with ${PORT_0}. Only the first: a command
// with two ports (say an app port and a debug port) needs a human decision, and
// silently rewriting both would be worse than rewriting one and saying so.
export function rewritePort(command: string): PortRewrite {
  for (const { pattern, style } of PORT_PATTERNS) {
    const match = command.match(pattern)
    if (!match) continue

    const original = Number(match[2])
    if (!isValidPort(original)) continue

    return {
      command: command.replace(pattern, `$1${PORT_PLACEHOLDER}`),
      style,
      originalPort: original
    }
  }

  return { command, style: 'none', originalPort: null }
}

// Forces `command` to bind to the worktree's own port.
//
// `style` describes how the *underlying* command names its port, which is what
// decides the override: a `--port` flag in a package.json script beats a PORT
// env var, so it has to be overridden in kind. When nothing was detected we fall
// back to exporting PORT, which most dev servers honour — best effort, and the
// caller marks the service so the user can correct it.
export function forcePort(command: string, style: PortStyle, flagPassthrough: boolean): string {
  if (style === 'flag' && flagPassthrough) {
    return `${command} -- --port ${PORT_PLACEHOLDER}`
  }
  if (style === 'flag') {
    return `${command} --port ${PORT_PLACEHOLDER}`
  }
  return `PORT=${PORT_PLACEHOLDER} ${command}`
}

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65535
}

// A localhost URL on the worktree's first allocated port. Used for both the
// preview and health fields, which take the same form for every service Grove
// can detect.
export function localhostUrl(): string {
  return `http://localhost:${PORT_PLACEHOLDER}`
}
