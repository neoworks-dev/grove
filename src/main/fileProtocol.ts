// grove-file:// serves files from an open worktree to the renderer's media
// viewers, so an <img>, <video> or a model loader can point straight at a file
// on disk. URLs are `grove-file://worktree/<worktree id>/<path inside it>`: the
// path stays hierarchical, so a glTF's buffers or an OBJ's materials resolve
// relative to the file that names them.
//
// Video and audio seek with Range requests, which this answers with 206s.
// `registerFileScheme` must run before app ready.

import { protocol } from 'electron'
import { createReadStream } from 'fs'
import { realpath, stat } from 'fs/promises'
import { extname, join } from 'path'
import { isInside } from './api/broker'
import type { Worktree } from '../shared/types'

const WORKTREE_HOST = 'worktree'

// Viewers sniff most formats themselves; these are the ones a browser element
// refuses or misreads without a type.
const CONTENT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary'
}

interface ByteRange {
  start: number
  end: number
}

/** Declares the scheme's privileges; must run before app ready. */
export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'grove-file',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

/** Serves grove-file:// from the worktrees `findWorktree` knows; returns the inverse. */
export function registerFileProtocol(findWorktree: (worktreeId: string) => Worktree): () => void {
  protocol.handle('grove-file', async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== WORKTREE_HOST) return new Response('unknown host', { status: 404 })

    const [encodedWorktreeId, ...segments] = url.pathname.replace(/^\//, '').split('/')
    if (!encodedWorktreeId || segments.length === 0) {
      return new Response('bad file path', { status: 400 })
    }

    const filePath = await resolveInsideWorktree(
      findWorktree,
      decodeURIComponent(encodedWorktreeId),
      segments.map(decodeURIComponent)
    )
    if (!filePath) return new Response('not found', { status: 404 })
    return serveFile(filePath, request.headers.get('range'))
  })
  return () => protocol.unhandle('grove-file')
}

/**
 * Resolves the requested file to its real path, or null when the worktree is
 * unknown, the file is missing, or it lies outside the worktree once symlinks
 * are followed.
 */
async function resolveInsideWorktree(
  findWorktree: (worktreeId: string) => Worktree,
  worktreeId: string,
  segments: string[]
): Promise<string | null> {
  let worktree: Worktree
  try {
    worktree = findWorktree(worktreeId)
  } catch {
    return null
  }
  try {
    const root = await realpath(worktree.path)
    const target = await realpath(join(root, ...segments))
    if (!isInside(root, target)) return null
    return target
  } catch {
    return null
  }
}

/** Answers with the whole file, or with the one byte range the request asked for. */
async function serveFile(filePath: string, rangeHeader: string | null): Promise<Response> {
  const info = await stat(filePath)
  if (!info.isFile()) return new Response('not a file', { status: 404 })

  const headers: Record<string, string> = {
    'Content-Type': contentTypeOf(filePath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache'
  }

  if (rangeHeader === null) {
    headers['Content-Length'] = String(info.size)
    return new Response(streamOf(filePath), { status: 200, headers })
  }

  const range = parseRange(rangeHeader, info.size)
  if (!range) {
    headers['Content-Range'] = `bytes */${info.size}`
    return new Response(null, { status: 416, headers })
  }
  headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`
  headers['Content-Length'] = String(range.end - range.start + 1)
  return new Response(streamOf(filePath, range), { status: 206, headers })
}

/**
 * The file, or a slice of it, as a web stream a Response can carry. Pulled a
 * chunk at a time, and the file closed when the reader gives up — a video
 * element cancels a range as soon as the user seeks elsewhere.
 */
function streamOf(filePath: string, range?: ByteRange): ReadableStream<Uint8Array> {
  const fileStream = createReadStream(filePath, range)
  const chunks = fileStream[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next()
      if (next.done) {
        controller.close()
        return
      }
      const chunk: Buffer = next.value
      controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    },
    cancel() {
      fileStream.destroy()
    }
  })
}

/** The MIME type a viewer expects for this file, by extension. */
function contentTypeOf(filePath: string): string {
  const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()]
  if (contentType === undefined) return 'application/octet-stream'
  return contentType
}

/**
 * Parses a single `bytes=` range against a file of `size` bytes, or returns null
 * when it cannot be satisfied. Multi-range requests are not something a media
 * element sends, so only the first range is honoured.
 */
export function parseRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)/.exec(header.trim())
  if (!match) return null
  const [, startText, endText] = match
  if (startText === '' && endText === '') return null

  // `bytes=-500` is the last 500 bytes.
  if (startText === '') {
    const length = Math.min(Number(endText), size)
    if (length === 0) return null
    return { start: size - length, end: size - 1 }
  }

  const start = Number(startText)
  let end = size - 1
  if (endText !== '') end = Math.min(Number(endText), size - 1)
  if (start >= size || start > end) return null
  return { start, end }
}
