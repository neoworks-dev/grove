// Grove's native-messaging host, which Chrome (or Chromium, Edge, Brave)
// starts for Grove's extension. It runs on Grove's own Electron binary with
// ELECTRON_RUN_AS_NODE, from the launcher "Connect Chrome" writes, which sets:
//   GROVE_API_DISCOVERY  the grove-api.json of the Grove that installed it
//   GROVE_BROWSER_TOKEN  where its pairing token is kept
// stdout carries Chrome's messages and nothing else; logging goes to stderr.
// Chrome closes stdin when the extension disconnects, and the host exits.

import { GroveLink, type FromBrowserMessage, type ToBrowserMessage } from './link'
import { NativeMessageDecoder, encodeNativeMessage } from './nativeMessaging'

/** Starts the host on this process's stdio. */
function main(): void {
  // Anything printed to stdout would corrupt Chrome's stream.
  console.log = console.error
  const discoveryPath = requiredEnv('GROVE_API_DISCOVERY')
  const tokenPath = requiredEnv('GROVE_BROWSER_TOKEN')
  const link = new GroveLink({
    discoveryPath,
    tokenPath,
    toBrowser: writeToBrowser,
    log: (line) => process.stderr.write(`grove browser host: ${line}\n`)
  })
  const decoder = new NativeMessageDecoder()
  process.stdin.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) link.fromBrowser(message as FromBrowserMessage)
  })
  process.stdin.on('end', () => {
    link.stop()
    process.exit(0)
  })
  link.start()
}

/** Writes one message to Chrome. */
function writeToBrowser(message: ToBrowserMessage): void {
  process.stdout.write(encodeNativeMessage(message))
}

/** An environment variable the launcher sets; exits when it is missing. */
function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value) return value
  process.stderr.write(`grove browser host: ${name} is not set; reinstall it from Grove's settings\n`)
  process.exit(1)
}

main()
