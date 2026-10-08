// Rambles from the desktop overlay (neoworks/overlay). The overlay finds this
// socket by the pid of the window the user is looking at, so a ramble goes to
// whichever app has focus. One JSON line in, `{capture}` (see
// shared/ramble.ts), one JSON line back.
//
// The socket is the user's alone (0600, in their runtime dir), the same trust
// as their terminal; unlike the paired API socket there is no token.

import { BrowserWindow } from 'electron'
import { chmod, mkdir, readFile, rm } from 'fs/promises'
import { createServer, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { isAbsolute, join } from 'path'
import { createInterface } from 'readline'
import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import {
  CAPTURE_VERSION,
  type RambleCapture,
  type RambleDelivery,
  type RambleImage,
  type RambleReceipt
} from '../../shared/ramble'

/** How long the window gets to hand the ramble to its agent. */
const RECEIPT_TIMEOUT_MS = 5000
const MAX_IMAGES = 12
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

interface RambleRequest {
  capture?: unknown
}

type Reply = { ok: true; app: 'grove'; sessionId: string } | { ok: false; error: string }

export const rambleRoutes = {
  name: 'main/routes/ramble',

  apply(ctx: Context): void {
    const receipts = new Receipts()
    route(ctx, 'ramble:receipt', (_event, id: number, receipt: RambleReceipt) => {
      receipts.settle(id, receipt)
    })
    ctx.effect(() => listen(socketPath(), (request) => deliver(request, receipts)), 'ramble:socket')
  }
}

/** Where the overlay looks for this process: one socket per app instance, by pid. */
function socketPath(): string {
  return join(runtimeDirectory(), 'neoworks', 'rambles', `grove-${process.pid}.sock`)
}

function runtimeDirectory(): string {
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime) {
    return runtime
  }
  return tmpdir()
}

/** Ramble ids waiting on the window's answer. */
class Receipts {
  private nextId = 1
  private waiting = new Map<number, (receipt: RambleReceipt) => void>()

  issue(): { id: number; receipt: Promise<RambleReceipt> } {
    const id = this.nextId++
    const receipt = new Promise<RambleReceipt>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolve({ sessionId: null, error: 'the window did not answer' })
      }, RECEIPT_TIMEOUT_MS)
      this.waiting.set(id, (answer) => {
        clearTimeout(timer)
        resolve(answer)
      })
    })
    return { id, receipt }
  }

  settle(id: number, receipt: RambleReceipt): void {
    const resolve = this.waiting.get(id)
    if (resolve === undefined) return
    this.waiting.delete(id)
    resolve(receipt)
  }
}

async function deliver(request: RambleRequest, receipts: Receipts): Promise<Reply> {
  let capture: RambleCapture
  try {
    capture = captureOf(request.capture)
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
  const window = targetWindow()
  if (window === null) {
    return { ok: false, error: 'no grove window' }
  }
  let images: RambleImage[]
  try {
    images = await readImages(capture.screenshots.map((shot) => shot.path))
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
  const { id, receipt } = receipts.issue()
  const delivery: RambleDelivery = { id, capture, images }
  window.webContents.send('event:ramble', delivery)
  const answer = await receipt
  if (answer.sessionId === null) {
    return { ok: false, error: answer.error === undefined ? 'not delivered' : answer.error }
  }
  return { ok: true, app: 'grove', sessionId: answer.sessionId }
}

/** The window the user is in; the first one if none has focus. */
function targetWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused !== null) return focused
  const all = BrowserWindow.getAllWindows()
  if (all.length === 0) return null
  return all[0]
}

/**
 * The capture, checked as far as grove relies on it: the version it knows,
 * words to send, and lists where lists go. Events are shown and described as
 * they come; one of a kind grove doesn't know shows as unknown.
 */
function captureOf(value: unknown): RambleCapture {
  if (value === null || typeof value !== 'object') throw new Error('capture required')
  const capture = value as RambleCapture
  if (capture.version !== CAPTURE_VERSION) throw new Error(`capture version ${String(capture.version)} not supported`)
  const lists = [capture.words, capture.events, capture.screenshots, capture.speechErrors]
  if (!lists.every((list) => Array.isArray(list))) throw new Error('capture is malformed')
  if (capture.words.length === 0) throw new Error('nothing was said')
  if (capture.screenshots.length > MAX_IMAGES) throw new Error(`more than ${MAX_IMAGES} screenshots`)
  return capture
}

async function readImages(paths: string[]): Promise<RambleImage[]> {
  const images: RambleImage[] = []
  for (const path of paths) {
    if (typeof path !== 'string' || !isAbsolute(path) || !path.endsWith('.png')) {
      throw new Error(`not a png path: ${String(path)}`)
    }
    const bytes = await readFile(path)
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`image too large: ${path}`)
    images.push({ bytes: new Uint8Array(bytes), filename: path.slice(path.lastIndexOf('/') + 1) })
  }
  return images
}

/** Serves the socket until the returned function is called. */
async function listen(path: string, handle: (request: RambleRequest) => Promise<Reply>): Promise<() => Promise<void>> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  // A socket left by a crashed run would block the listen.
  await rm(path, { force: true })
  const server = createServer((socket) => serve(socket, handle))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolve())
  })
  await chmod(path, 0o600)
  return () => close(server, path)
}

function serve(socket: Socket, handle: (request: RambleRequest) => Promise<Reply>): void {
  const lines = createInterface({ input: socket })
  lines.on('line', (line) => {
    void answer(line, handle).then((reply) => socket.write(`${JSON.stringify(reply)}\n`))
  })
  socket.on('error', () => lines.close())
}

async function answer(line: string, handle: (request: RambleRequest) => Promise<Reply>): Promise<Reply> {
  let request: RambleRequest
  try {
    request = parseRequest(line)
  } catch {
    return { ok: false, error: 'not JSON' }
  }
  try {
    return await handle(request)
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

function parseRequest(line: string): RambleRequest {
  const parsed: unknown = JSON.parse(line)
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('not an object')
  }
  return parsed
}

async function close(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(path, { force: true })
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
