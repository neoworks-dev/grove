// Turning what a debugger call failed with into a line a person can read.

/** An IPC error's message without Electron's "Error invoking remote method" prefix. */
export function messageOf(error: unknown): string {
  let message = 'unknown error'
  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === 'string') {
    message = error
  }
  return message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}
