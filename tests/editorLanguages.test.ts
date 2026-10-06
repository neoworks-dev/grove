// The language servers the agent tools run are the editor's: read from the
// dump the editor's nvim profile writes, chosen like Grove's own catalog
// entries, and named by nvim's filetypes. The case that started this: a
// `.svelte` file, served by svelteserver in the editor, had no server for
// agents because Grove's own list knew only two and called the file `html`.

import { describe, expect, test } from 'bun:test'
import {
  EditorLanguageCatalog,
  NO_EDITOR_LANGUAGES,
  editorServerEntries,
  filetypeOf,
  parseEditorLanguages,
  type EditorLanguages
} from '../src/main/editorLanguages'
import { chooseLspServer } from '../src/main/lspServerChoice'
import type { CatalogEntry } from '../src/shared/types'

// What the editor's profile wrote on a machine with Mason's svelte and vtsls.
const DUMP = JSON.stringify({
  servers: [
    { name: 'svelte', cmd: ['svelteserver', '--stdio'], filetypes: ['svelte'] },
    {
      name: 'vtsls',
      cmd: ['vtsls', '--stdio'],
      filetypes: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact']
    }
  ],
  extensions: { svelte: 'svelte', ts: 'typescript', tsx: 'typescriptreact', md: 'markdown' }
})

// Grove's own fallback entry, as editorCatalog.ts lists it.
const typescriptLanguageServer: CatalogEntry = {
  id: 'typescript-language-server',
  kind: 'lsp',
  name: 'TypeScript / JavaScript LSP',
  lsp: { command: 'typescript-language-server', args: ['--stdio'], languages: ['typescript', 'javascript'] }
}

const masonBin = '/home/me/.config/grove/nvim-runtime/data/nvim/mason/bin'

/** Finds only the binaries named, as if they sat in Mason's bin. */
function finder(available: string[]): (name: string) => string | null {
  return (name) => {
    if (!available.includes(name)) return null
    return `${masonBin}/${name}`
  }
}

describe('the editor language dump', () => {
  test('reads servers as command lines and extensions as filetypes', () => {
    const languages = parseEditorLanguages(DUMP)
    expect(languages.servers[0]).toEqual({
      name: 'svelte',
      command: 'svelteserver',
      args: ['--stdio'],
      filetypes: ['svelte']
    })
    expect(languages.extensions.tsx).toBe('typescriptreact')
  })

  test('leaves out what it cannot run and reads an empty map written as a list', () => {
    const languages = parseEditorLanguages(
      JSON.stringify({
        servers: [{ name: 'broken', cmd: [], filetypes: ['x'] }, { name: 'nofiles', cmd: ['x'] }, 'junk'],
        extensions: []
      })
    )
    expect(languages).toEqual(NO_EDITOR_LANGUAGES)
  })

  test('reads nothing from something that is not the dump', () => {
    expect(parseEditorLanguages('not json')).toEqual(NO_EDITOR_LANGUAGES)
  })
})

describe('choosing among the editor servers', () => {
  const languages = parseEditorLanguages(DUMP)

  test('gives a .svelte file the server the editor runs for it', () => {
    const language = filetypeOf(languages, '/repo/src/App.svelte')
    expect(language).toBe('svelte')

    const catalog = [...editorServerEntries(languages), typescriptLanguageServer]
    const choice = chooseLspServer(String(language), catalog, [], finder(['svelteserver']))
    expect(choice?.entry.lsp).toEqual({ command: 'svelteserver', args: ['--stdio'], languages: ['svelte'] })
    expect(choice?.executable).toBe(`${masonBin}/svelteserver`)
  })

  test("prefers the editor's server over Grove's own entry for the same language", () => {
    const catalog = [...editorServerEntries(languages), typescriptLanguageServer]
    const available = finder(['vtsls', 'typescript-language-server'])
    expect(chooseLspServer('typescript', catalog, [], available)?.entry.name).toBe('vtsls')
  })

  test('still falls back to Grove\'s own entry when the editor has none', () => {
    const catalog = [...editorServerEntries(NO_EDITOR_LANGUAGES), typescriptLanguageServer]
    const choice = chooseLspServer('typescript', catalog, [], finder(['typescript-language-server']))
    expect(choice?.entry.id).toBe('typescript-language-server')
  })
})

describe('filetypeOf', () => {
  const languages = parseEditorLanguages(DUMP)

  test("names a file by nvim's filetype for its extension, in any case", () => {
    expect(filetypeOf(languages, 'a/b.tsx')).toBe('typescriptreact')
    expect(filetypeOf(languages, 'README.MD')).toBe('markdown')
  })

  test('has nothing for an unknown extension, a dotfile or no extension', () => {
    expect(filetypeOf(languages, 'a.unknown')).toBeNull()
    expect(filetypeOf(languages, '.svelte')).toBeNull()
    expect(filetypeOf(languages, 'Makefile')).toBeNull()
  })
})

describe('EditorLanguageCatalog', () => {
  /** A catalog over a reader that counts its reads, on a clock the test moves. */
  function counted(read: () => Promise<EditorLanguages>): {
    catalog: EditorLanguageCatalog
    reads: () => number
    logged: string[]
    advance: (ms: number) => void
  } {
    let reads = 0
    let time = 0
    const logged: string[] = []
    const catalog = new EditorLanguageCatalog(
      () => {
        reads += 1
        return read()
      },
      (line) => logged.push(line),
      () => time
    )
    return { catalog, reads: () => reads, logged, advance: (ms) => (time += ms) }
  }

  test('reads the editor once, however often it is asked', async () => {
    const { catalog, reads } = counted(() => Promise.resolve(parseEditorLanguages(DUMP)))
    await Promise.all([catalog.current(), catalog.current()])
    await catalog.current()
    expect(reads()).toBe(1)
  })

  test('reads again after a miss only once the last read is a minute old', async () => {
    const { catalog, reads, advance } = counted(() => Promise.resolve(parseEditorLanguages(DUMP)))
    await catalog.current()
    await catalog.afterMiss()
    expect(reads()).toBe(1)

    advance(60_000)
    await catalog.afterMiss()
    expect(reads()).toBe(2)
  })

  test('reports a failed read and serves nothing from the editor', async () => {
    const { catalog, logged } = counted(() => Promise.reject(new Error('nvim exited 1')))
    expect(await catalog.current()).toEqual(NO_EDITOR_LANGUAGES)
    expect(logged).toEqual(['lsp: nvim exited 1'])
  })
})
