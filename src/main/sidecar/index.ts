// Grove's main process as the native app's sidecar: `bun src/main/sidecar/index.ts`.
// The Rust host spawns it, writes request frames to its stdin and reads reply and
// event frames from its stdout (see transport.ts). Stdout carries frames and nothing
// else, so everything that would be printed there goes to stderr.

import { installPlatform } from '../platform'
import { createSidecarPlatform } from '../platform/sidecar'
import { StdioTransport } from './transport'

/** How long the services get to close before the process leaves anyway. */
const SHUTDOWN_DEADLINE_MS = 3_000

/** Writes a diagnostic line to stderr, the only stream that is not a frame. */
function log(message: string): void {
  console.error(message)
}

/** Sends `console.log` and its siblings to stderr, so a stray print cannot corrupt a frame. */
function keepStdoutForFrames(): void {
  console.log = console.error
  console.info = console.error
  console.debug = console.error
}

let stopping = false

/** Closes the services, then exits; leaves anyway after the deadline so a stuck one cannot hold the process. */
async function stop(shutdown: () => Promise<void>, reason: string): Promise<void> {
  if (stopping) {
    return
  }
  stopping = true
  log(`[sidecar] stopping: ${reason}`)
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DEADLINE_MS))
  await Promise.race([shutdown().catch(() => {}), deadline])
  process.exit(0)
}

/** Installs the sidecar host, mounts every route and starts answering the host. */
async function main(): Promise<void> {
  keepStdoutForFrames()
  const transport = new StdioTransport(process.stdout, log)
  installPlatform(createSidecarPlatform({ transport, log }))

  // Loaded only now: these modules read the platform as they are evaluated.
  const { registerIpc, shutdown } = await import('../ipc')
  await registerIpc()

  // Requests wait in the pipe until every route exists, so none can find it missing.
  transport.listen(process.stdin, () => void stop(shutdown, 'the host closed stdin'))
  process.once('SIGTERM', () => void stop(shutdown, 'SIGTERM'))
  process.once('SIGINT', () => void stop(shutdown, 'SIGINT'))
  log(`[sidecar] ready: ${transport.channels().length} routes, pid ${process.pid}`)
}

// Same benign race index.ts swallows: a language server dying mid-write.
process.on('unhandledRejection', (reason) => {
  const error = reason as NodeJS.ErrnoException | undefined
  if (error && error.code === 'ERR_STREAM_DESTROYED') {
    return
  }
  console.error('Unhandled promise rejection:', reason)
})

main().catch((error: Error) => {
  log(`[sidecar] failed to start: ${error.stack}`)
  process.exit(1)
})
