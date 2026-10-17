// The desktop's own tools, for a host that is not a desktop app and so has no clipboard,
// no "open with" and no keychain of its own to call: the clipboard through whichever of
// wl-clipboard, xclip, xsel or pbcopy exists, and files and links through the opener.

import { spawn, spawnSync } from 'node:child_process'

interface ClipboardTool {
  read: string[]
  write: string[]
}

/** The clipboard commands this system is likely to have, in the order they are tried. */
function clipboardTools(): ClipboardTool[] {
  if (process.platform === 'darwin') {
    return [{ read: ['pbpaste'], write: ['pbcopy'] }]
  }
  if (process.platform === 'win32') {
    return [{ read: ['powershell', '-command', 'Get-Clipboard'], write: ['clip'] }]
  }
  return [
    { read: ['wl-paste', '--no-newline'], write: ['wl-copy'] },
    { read: ['xclip', '-selection', 'clipboard', '-o'], write: ['xclip', '-selection', 'clipboard'] },
    { read: ['xsel', '--clipboard', '--output'], write: ['xsel', '--clipboard', '--input'] }
  ]
}

/** Reads the clipboard's text, or an empty string when no tool can. */
export function readClipboardText(): string {
  for (const tool of clipboardTools()) {
    const [command, ...args] = tool.read
    const result = spawnSync(command, args, { encoding: 'utf8' })
    if (result.status === 0) {
      return result.stdout
    }
  }
  return ''
}

/** Puts text on the clipboard; throws when no tool is installed to do it. */
export function writeClipboardText(text: string): void {
  for (const tool of clipboardTools()) {
    const [command, ...args] = tool.write
    const result = spawnSync(command, args, { input: text })
    if (result.status === 0) {
      return
    }
  }
  throw new Error('no clipboard tool is installed (wl-copy, xclip, xsel or pbcopy)')
}

/** The command that opens a file or link with the user's default app. */
function openerCommand(target: string): { command: string; args: string[] } {
  if (process.platform === 'darwin') {
    return { command: 'open', args: [target] }
  }
  if (process.platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', target] }
  }
  return { command: 'xdg-open', args: [target] }
}

/** Opens the file or link with the default app, resolving to an error message or '' once it started. */
export function openWithDefaultApp(target: string): Promise<string> {
  const { command, args } = openerCommand(target)
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', (error) => resolve(`could not run ${command}: ${error.message}`))
    child.once('spawn', () => {
      child.unref()
      resolve('')
    })
  })
}
