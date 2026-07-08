// Dispatch for plugin-scoped privileged calls (plugins:invoke). Every method
// runs through the PermissionBroker; streaming methods keep a per-call handle
// so individual calls can be cancelled (and all of a plugin's calls when its
// worker dies).

import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname, isAbsolute, join } from 'path'
import type { Worktree } from '../../shared/types'
import * as files from '../files'
import * as search from '../search'
import { PermissionBroker, PermissionError } from './broker'
import type { PluginRegistry, PluginRecord } from './loader'

interface RouterDeps {
  broker: PermissionBroker
  registry: PluginRegistry
  findWorktree: (worktreeId: string) => Worktree
  send: (channel: string, payload: unknown) => void
}

interface StreamHandle {
  pluginId: string
  cancel: () => void
}

const STREAM_BATCH_MS = 60
const STREAM_BATCH_SIZE = 100

function storagePath(): string {
  return join(app.getPath('userData'), 'plugin-storage.json')
}

export class PluginRouter {
  private deps: RouterDeps
  private streams = new Map<string, StreamHandle>()

  constructor(deps: RouterDeps) {
    this.deps = deps
  }

  private record(pluginId: string): PluginRecord {
    const record = this.deps.registry.get(pluginId)
    if (!record || record.status !== 'ready') {
      throw new PermissionError(`plugin not available: ${pluginId}`)
    }
    return record
  }

  async invoke(pluginId: string, callId: string, method: string, params: unknown): Promise<unknown> {
    const record = this.record(pluginId)
    const args = (params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'workspace.findFiles':
        return this.findFiles(record, args)
      case 'workspace.readFile':
        return this.readFile(record, args)
      case 'workspace.readExcerpt':
        return this.readExcerpt(record, args)
      case 'workspace.writeFile':
        return this.writeFile(record, args)
      case 'workspace.searchText':
        return this.searchText(record, callId, args)
      case 'storage.get':
        return this.storageGet(record, args)
      case 'storage.set':
        return this.storageSet(record, args)
      case 'storage.delete':
        return this.storageDelete(record, args)
      default:
        throw new Error(`unknown plugin method: ${method}`)
    }
  }

  cancel(pluginId: string, callId: string): void {
    const handle = this.streams.get(callId)
    if (!handle || handle.pluginId !== pluginId) return
    handle.cancel()
    this.streams.delete(callId)
  }

  cancelAllForPlugin(pluginId: string): void {
    for (const [callId, handle] of this.streams) {
      if (handle.pluginId !== pluginId) continue
      handle.cancel()
      this.streams.delete(callId)
    }
  }

  // ── Workspace ─────────────────────────────────────────────────
  private worktreeFor(args: Record<string, unknown>): Worktree {
    return this.deps.findWorktree(String(args.worktreeId ?? ''))
  }

  private absolutePath(worktree: Worktree, path: string): string {
    if (isAbsolute(path)) return path
    return join(worktree.path, path)
  }

  private async findFiles(record: PluginRecord, args: Record<string, unknown>): Promise<string[]> {
    const worktree = this.worktreeFor(args)
    await this.deps.broker.ensure(record, 'workspace.read', `list files in ${worktree.path}`)
    return files.listAll(worktree.path)
  }

  private async readFile(record: PluginRecord, args: Record<string, unknown>): Promise<string> {
    const worktree = this.worktreeFor(args)
    const absPath = this.absolutePath(worktree, String(args.path ?? ''))
    await this.deps.broker.ensurePath(record, 'read', absPath, worktree.path)
    return files.readFileContent(worktree.path, absPath)
  }

  private async readExcerpt(
    record: PluginRecord,
    args: Record<string, unknown>
  ): Promise<{ n: number; text: string }[]> {
    const content = await this.readFile(record, args)
    const startLine = Math.max(1, Number(args.startLine ?? 1))
    const endLine = Math.max(startLine, Number(args.endLine ?? startLine))
    const lines = content.split('\n')
    const excerpt: { n: number; text: string }[] = []
    for (let n = startLine; n <= Math.min(endLine, lines.length); n++) {
      excerpt.push({ n, text: lines[n - 1] })
    }
    return excerpt
  }

  private async writeFile(record: PluginRecord, args: Record<string, unknown>): Promise<void> {
    const worktree = this.worktreeFor(args)
    const absPath = this.absolutePath(worktree, String(args.path ?? ''))
    await this.deps.broker.ensurePath(record, 'write', absPath, worktree.path)
    await files.writeFileContent(worktree.path, absPath, String(args.content ?? ''))
  }

  // Streaming: batches matches to event:plugin-stream, ends with an 'end'.
  private async searchText(
    record: PluginRecord,
    callId: string,
    args: Record<string, unknown>
  ): Promise<null> {
    const worktree = this.worktreeFor(args)
    await this.deps.broker.ensure(record, 'workspace.read', `search in ${worktree.path}`)
    const query = String(args.query ?? '')
    let batch: search.SearchMatch[] = []
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      if (batch.length === 0) return
      this.deps.send('event:plugin-stream', { pluginId: record.id, callId, chunk: batch })
      batch = []
    }
    const handle = search.ripgrepSearch(
      worktree.path,
      query,
      (match) => {
        batch.push(match)
        if (batch.length >= STREAM_BATCH_SIZE) flush()
        else if (!timer) timer = setTimeout(flush, STREAM_BATCH_MS)
      },
      () => {
        flush()
        this.streams.delete(callId)
        this.deps.send('event:plugin-stream', { pluginId: record.id, callId, end: true })
      }
    )
    this.streams.set(callId, { pluginId: record.id, cancel: () => handle.cancel() })
    return null
  }

  // ── Plugin-scoped storage ─────────────────────────────────────
  private async readStorage(): Promise<Record<string, Record<string, unknown>>> {
    try {
      return JSON.parse(await readFile(storagePath(), 'utf8'))
    } catch {
      return {}
    }
  }

  private async storageGet(record: PluginRecord, args: Record<string, unknown>): Promise<unknown> {
    await this.deps.broker.ensure(record, 'state', 'read plugin storage')
    const storage = await this.readStorage()
    return storage[record.id]?.[String(args.key ?? '')]
  }

  private async storageSet(record: PluginRecord, args: Record<string, unknown>): Promise<void> {
    await this.deps.broker.ensure(record, 'state', 'write plugin storage')
    const storage = await this.readStorage()
    const section = storage[record.id] ?? {}
    section[String(args.key ?? '')] = args.value
    storage[record.id] = section
    await mkdir(dirname(storagePath()), { recursive: true })
    await writeFile(storagePath(), JSON.stringify(storage, null, 2), 'utf8')
  }

  private async storageDelete(record: PluginRecord, args: Record<string, unknown>): Promise<void> {
    await this.deps.broker.ensure(record, 'state', 'write plugin storage')
    const storage = await this.readStorage()
    delete storage[record.id]?.[String(args.key ?? '')]
    await writeFile(storagePath(), JSON.stringify(storage, null, 2), 'utf8')
  }
}
