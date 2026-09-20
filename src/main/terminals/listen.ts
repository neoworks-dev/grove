// Binding the daemon's socket, and telling a live daemon apart from the socket
// file a dead one left behind.
//
// A unix socket path is only cleaned up when the process holding it closes the
// server. A daemon that is killed, crashes, or is still "running" when the
// machine reboots leaves the file where it is, and every later `listen` on that
// path fails with EADDRINUSE — which reads exactly like another daemon owning
// it. Connecting is what tells the two apart: a live daemon accepts, a corpse
// refuses.

import { unlinkSync } from 'node:fs'
import { connect, type Server } from 'node:net'

/** What happened to a bind attempt: we own the path now, or somebody else does. */
export type ListenOutcome = 'listening' | 'taken'

/**
 * Listen on a socket path, stepping past a socket file no daemon is behind.
 *
 * Returns 'taken' only when something actually answers on the path, so the
 * caller can stand down knowing the terminals have a daemon either way.
 */
export async function listenPastStaleSocket(
  server: Server,
  socketPath: string
): Promise<ListenOutcome> {
  const first = await tryListen(server, socketPath)
  if (first === 'listening') return 'listening'

  if (await isSomeoneListening(socketPath)) return 'taken'

  removeSocket(socketPath)
  // A second EADDRINUSE means a daemon claimed the path between the probe and
  // here — a real race this time, and theirs to serve.
  return tryListen(server, socketPath)
}

/** One bind attempt. Anything that is not the path being in use is a real fault. */
function tryListen(server: Server, socketPath: string): Promise<ListenOutcome> {
  return new Promise((resolve, reject) => {
    const onError = (cause: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      if (cause.code === 'EADDRINUSE') {
        resolve('taken')
        return
      }
      reject(cause)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve('listening')
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(socketPath)
  })
}

/** Whether a process is accepting connections on the path right now. */
function isSomeoneListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath)
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
  })
}

/** Drop the socket file. Named pipes on Windows have no path to unlink. */
export function removeSocket(socketPath: string): void {
  if (process.platform === 'win32') return
  try {
    unlinkSync(socketPath)
  } catch {
    // Already gone.
  }
}
