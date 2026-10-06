// grove mode's rename: the language server says what to change, the tool
// changes every file or none of them.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol'
import type { GroveToolContext } from '../src/main/agents/harness'
import { applyTextEdits, renameTool, type AgentLanguages } from '../src/main/agents/tools/lspTools'
import {
  joinText,
  splitText,
  type FileText,
  type WorkspaceFiles
} from '../src/main/agents/tools/workspaceFiles'

/** Files kept in memory, by absolute path. */
function memoryFiles(initial: Record<string, string>): WorkspaceFiles & { text(path: string): string | undefined } {
  const texts = new Map(Object.entries(initial))
  return {
    read(path): Promise<FileText> {
      const text = texts.get(path)
      if (text === undefined) {
        return Promise.resolve({ lines: [''], eol: '\n', finalNewline: true, exists: false, unsaved: false })
      }
      return Promise.resolve({ ...splitText(text), exists: true, unsaved: false })
    },
    write(path, read, lines) {
      texts.set(path, joinText(lines, read))
      return Promise.resolve()
    },
    text: (path) => texts.get(path)
  }
}

/** nvim's filetype for the extensions these tests use. */
function languageOf(path: string): Promise<string> {
  if (path.endsWith('.tsx')) return Promise.resolve('typescriptreact')
  if (path.endsWith('.ts')) return Promise.resolve('typescript')
  return Promise.resolve('markdown')
}

/** A TypeScript server: it handles .ts and .tsx, and nothing else. */
function servedTogether(language: string, other: string): Promise<boolean> {
  const typescript = ['typescript', 'typescriptreact']
  return Promise.resolve(language === other || (typescript.includes(language) && typescript.includes(other)))
}

/** A language server that answers every rename with the given edit, and records where it was asked. */
function languagesAnswering(edit: WorkspaceEdit | null): AgentLanguages & { asked: unknown[] } {
  const asked: unknown[] = []
  return {
    asked,
    languageOf,
    servedTogether,
    sync: () => Promise.resolve(true),
    rename: (_worktree: string, _language: string, uri: string, position: unknown, newName: string) => {
      asked.push({ uri, position, newName })
      return Promise.resolve(edit)
    }
  } as unknown as AgentLanguages & { asked: unknown[] }
}

const context: GroveToolContext = {
  sessionId: 's1',
  workspaceRoot: '/w',
  surface: () => {},
  show: () => {}
}

const worktrees = (): { id: string; path: string }[] => [{ id: 'w', path: '/w' }]

/** An edit putting `newText` over `length` characters at a position. */
function at(line: number, character: number, length: number, newText: string): TextEdit {
  return {
    range: { start: { line, character }, end: { line, character: character + length } },
    newText
  }
}

describe('the rename tool', () => {
  test('asks at the named symbol and changes every file the server names', async () => {
    const files = memoryFiles({
      '/w/a.ts': 'export const count = 1\n',
      '/w/b.ts': "import { count } from './a'\nconsole.log(count)\n"
    })
    const languages = languagesAnswering({
      changes: {
        'file:///w/a.ts': [at(0, 13, 5, 'total')],
        'file:///w/b.ts': [at(0, 9, 5, 'total'), at(1, 12, 5, 'total')]
      }
    })
    const tool = renameTool(languages, files, worktrees)

    const result = await tool.execute({ path: 'a.ts', line: 1, symbol: 'count', newName: 'total' }, context)

    expect(result.isError).toBeUndefined()
    expect(languages.asked).toEqual([
      { uri: 'file:///w/a.ts', position: { line: 0, character: 13 }, newName: 'total' }
    ])
    expect(files.text('/w/a.ts')).toBe('export const total = 1\n')
    expect(files.text('/w/b.ts')).toBe("import { total } from './a'\nconsole.log(total)\n")
    expect(result.content).toContain('3 changes in 2 files')
  })

  test('shows every file it would change as a diff, before writing any', async () => {
    const files = memoryFiles({ '/w/a.ts': 'const count = 1\n', '/w/b.ts': 'count\n' })
    const languages = languagesAnswering({
      changes: { 'file:///w/a.ts': [at(0, 6, 5, 'total')], 'file:///w/b.ts': [at(0, 0, 5, 'total')] }
    })
    const tool = renameTool(languages, files, worktrees)

    const update = await tool.describe?.({ path: 'a.ts', line: 1, symbol: 'count', newName: 'total' }, context)

    expect(update?.content?.map((item) => (item as { path: string }).path)).toEqual(['/w/a.ts', '/w/b.ts'])
    expect(files.text('/w/a.ts')).toBe('const count = 1\n')
  })

  test('writes nothing when one of the files is outside the worktree', async () => {
    const files = memoryFiles({ '/w/a.ts': 'const count = 1\n', '/elsewhere/c.ts': 'count\n' })
    const languages = languagesAnswering({
      changes: { 'file:///w/a.ts': [at(0, 6, 5, 'total')], 'file:///elsewhere/c.ts': [at(0, 0, 5, 'total')] }
    })
    const tool = renameTool(languages, files, worktrees)

    const result = await tool.execute({ path: 'a.ts', line: 1, symbol: 'count', newName: 'total' }, context)

    expect(result.isError).toBe(true)
    expect(files.text('/w/a.ts')).toBe('const count = 1\n')
  })

  test('refuses a rename that would also move files', async () => {
    const files = memoryFiles({ '/w/a.ts': 'const count = 1\n' })
    const languages = languagesAnswering({
      documentChanges: [{ kind: 'rename', oldUri: 'file:///w/a.ts', newUri: 'file:///w/b.ts' }]
    })
    const tool = renameTool(languages, files, worktrees)

    const result = await tool.execute({ path: 'a.ts', line: 1, symbol: 'count', newName: 'total' }, context)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('move')
  })

  test('says so when the server cannot rename there', async () => {
    const tool = renameTool(languagesAnswering(null), memoryFiles({ '/w/a.ts': 'const count = 1\n' }), worktrees)

    const result = await tool.execute({ path: 'a.ts', line: 1, symbol: 'const', newName: 'let' }, context)

    expect(result.isError).toBe(true)
  })
})

/** Files read from and written to disk. */
function diskFiles(): WorkspaceFiles {
  return {
    read(path): Promise<FileText> {
      return Promise.resolve({ ...splitText(readFileSync(path, 'utf8')), exists: true, unsaved: false })
    },
    write(path, read, lines) {
      writeFileSync(path, joinText(lines, read))
      return Promise.resolve()
    }
  }
}

describe('the rename tool on a real worktree', () => {
  test('shows the server every file that mentions the name first, and reports uses left behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grove-rename-'))
    writeFileSync(join(root, 'a.ts'), 'export const count = 1\n')
    writeFileSync(join(root, 'b.ts'), "import { count } from './a'\n")
    writeFileSync(join(root, 'c.tsx'), "import { count } from './a'\n")
    writeFileSync(join(root, 'notes.md'), 'count\n')
    const synced: { uri: string; language: string }[] = []
    const languages = {
      languageOf,
      servedTogether,
      sync: (_worktree: string, _path: string, language: string, uri: string) => {
        synced.push({ uri, language })
        return Promise.resolve(true)
      },
      // A server that knows only a.ts, as one without a project file might.
      rename: () => Promise.resolve({ changes: { [pathToFileURL(join(root, 'a.ts')).toString()]: [at(0, 13, 5, 'total')] } })
    } as unknown as AgentLanguages
    const tool = renameTool(languages, diskFiles(), () => [{ id: 'w', path: root }])

    const result = await tool.execute(
      { path: 'a.ts', line: 1, symbol: 'count', newName: 'total' },
      { ...context, workspaceRoot: root }
    )

    const uri = (name: string): string => pathToFileURL(join(root, name)).toString()
    expect(synced).toContainEqual({ uri: uri('b.ts'), language: 'typescript' })
    // Another filetype, but the same server: it has to see the file too, as itself.
    expect(synced).toContainEqual({ uri: uri('c.tsx'), language: 'typescriptreact' })
    expect(synced.map((entry) => entry.uri)).not.toContain(uri('notes.md'))
    expect(result.content).toContain('still appears')
    expect(result.content).toContain('b.ts:1')
  })
})

describe('text edits', () => {
  test('apply from the end, so earlier positions still hold', () => {
    const text = 'a b a\r\na\r\n'
    const layout = { ...splitText(text) }
    const edits = [at(0, 0, 1, 'xx'), at(0, 4, 1, 'xx'), at(1, 0, 1, 'xx')]
    expect(applyTextEdits(text, layout, edits, 'a.ts')).toBe('xx b xx\r\nxx\r\n')
  })

  test('fail on a position past the end of a line', () => {
    const text = 'short\n'
    expect(() => applyTextEdits(text, splitText(text), [at(0, 10, 1, 'x')], 'a.ts')).toThrow(/out of date/)
  })
})
