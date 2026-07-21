// Harpoon: pin a small set of files per project and jump between them with a
// keystroke. Marks live in plugin storage keyed by worktree id, so each project
// keeps its own independent list. Built entirely on the public plugin SDK.

import * as grove from '@grove/plugin-sdk'

interface Mark {
  path: string
  line: number
}

const PREVIEW_CONTEXT = 8

export function activate(context: grove.PluginContext): void {
  const storageKey = (worktreeId: string): string => `marks:${worktreeId}`

  async function currentWorktreeId(): Promise<string | null> {
    const worktree = await grove.workspace.getCurrentWorktree()
    if (!worktree) return null
    return worktree.id
  }

  async function loadMarks(worktreeId: string): Promise<Mark[]> {
    const stored = await context.storage.get<Mark[]>(storageKey(worktreeId))
    if (!stored) return []
    return stored
  }

  async function saveMarks(worktreeId: string, marks: Mark[]): Promise<void> {
    await context.storage.set(storageKey(worktreeId), marks)
  }

  async function pinCurrent(): Promise<void> {
    const worktreeId = await currentWorktreeId()
    if (!worktreeId) return

    const active = await grove.workspace.getActiveFile()
    if (!active) {
      grove.ui.notify({ level: 'warn', message: 'No active file to pin.' })
      return
    }

    const marks = await loadMarks(worktreeId)
    if (marks.some((mark) => mark.path === active.path)) {
      grove.ui.notify({ level: 'info', message: `Already pinned: ${active.path}` })
      return
    }

    marks.push({ path: active.path, line: active.line })
    await saveMarks(worktreeId, marks)
    grove.ui.notify({ level: 'info', message: `Pinned ${active.path} (${marks.length})` })
  }

  async function unpinCurrent(): Promise<void> {
    const worktreeId = await currentWorktreeId()
    if (!worktreeId) return

    const active = await grove.workspace.getActiveFile()
    if (!active) return

    const marks = await loadMarks(worktreeId)
    const next = marks.filter((mark) => mark.path !== active.path)
    if (next.length === marks.length) return

    await saveMarks(worktreeId, next)
    grove.ui.notify({ level: 'info', message: `Unpinned ${active.path}` })
  }

  async function clearMarks(): Promise<void> {
    const worktreeId = await currentWorktreeId()
    if (!worktreeId) return
    await saveMarks(worktreeId, [])
    grove.ui.notify({ level: 'info', message: 'Cleared all Harpoon marks.' })
  }

  async function openMark(mark: Mark): Promise<void> {
    await grove.workspace.openFile(mark.path, { line: mark.line })
  }

  async function gotoSlot(slot: number): Promise<void> {
    const worktreeId = await currentWorktreeId()
    if (!worktreeId) return
    const marks = await loadMarks(worktreeId)
    const mark = marks[slot - 1]
    if (!mark) return
    await openMark(mark)
  }

  // Cycle relative to the file currently open; wraps around the list.
  async function cycle(direction: 1 | -1): Promise<void> {
    const worktreeId = await currentWorktreeId()
    if (!worktreeId) return
    const marks = await loadMarks(worktreeId)
    if (marks.length === 0) return

    const active = await grove.workspace.getActiveFile()
    const currentIndex = active ? marks.findIndex((mark) => mark.path === active.path) : -1
    const base = currentIndex === -1 ? 0 : currentIndex + direction
    const nextIndex = (base + marks.length) % marks.length
    await openMark(marks[nextIndex])
  }

  context.subscriptions.push(
    grove.commands.register('harpoon.add', pinCurrent),
    grove.commands.register('harpoon.remove', unpinCurrent),
    grove.commands.register('harpoon.clear', clearMarks),
    grove.commands.register('harpoon.menu', () => grove.ui.overlays.open('harpoonMenu')),
    grove.commands.register('harpoon.next', () => cycle(1)),
    grove.commands.register('harpoon.prev', () => cycle(-1)),
    grove.commands.register('harpoon.goto1', () => gotoSlot(1)),
    grove.commands.register('harpoon.goto2', () => gotoSlot(2)),
    grove.commands.register('harpoon.goto3', () => gotoSlot(3)),
    grove.commands.register('harpoon.goto4', () => gotoSlot(4)),

    grove.ui.overlays.setHandler('harpoonMenu', {
      async onQuery(query, emit, token) {
        const worktreeId = await currentWorktreeId()
        if (!worktreeId || token.isCancelled) return

        const marks = await loadMarks(worktreeId)
        const needle = query.trim().toLowerCase()

        const items = marks
          .map((mark, index) => ({ mark, index }))
          .filter((entry) => needle.length === 0 || entry.mark.path.toLowerCase().includes(needle))
          .map((entry) => ({
            id: entry.mark.path,
            label: `${entry.index + 1}. ${entry.mark.path}`,
            description: `:${entry.mark.line}`,
            icon: `file:${entry.mark.path}`,
            data: entry.mark
          }))

        emit(items)
      },

      async onPreview(item, token) {
        const mark = item.data as Mark
        const lines = await grove.workspace.readExcerpt(
          mark.path,
          Math.max(1, mark.line - PREVIEW_CONTEXT),
          mark.line + PREVIEW_CONTEXT
        )
        if (token.isCancelled) return null
        return { kind: 'excerpt', file: mark.path, lines, highlightLine: mark.line }
      },

      async onAccept(items) {
        const mark = items[0]?.data as Mark | undefined
        if (mark) await openMark(mark)
      }
    })
  )
}
