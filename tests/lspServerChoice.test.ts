import { describe, expect, test } from 'bun:test'
import { chooseLspServer } from '../src/main/lspServerChoice'
import type { CatalogEntry } from '../src/shared/types'

/** A catalog lsp entry for python whose binary is `command`. */
function pythonServer(id: string, command: string): CatalogEntry {
  return {
    id,
    kind: 'lsp',
    name: id,
    description: '',
    lsp: { command, args: ['--stdio'], languages: ['python'] }
  } as CatalogEntry
}

const pyright = pythonServer('pyright', 'pyright-langserver')
const pylsp = pythonServer('pylsp', 'pylsp')
const masonBin = '/home/me/.config/grove/nvim-runtime/data/nvim/mason/bin'

/** Finds only the binaries named in `available`, as if they sat in Mason's bin. */
function finder(available: string[]): (name: string) => string | null {
  return (name) => {
    if (!available.includes(name)) return null
    return `${masonBin}/${name}`
  }
}

describe('chooseLspServer', () => {
  test('runs a server Mason installed without it being installed in Grove', () => {
    const choice = chooseLspServer('python', [pyright], [], finder(['pyright-langserver']))
    expect(choice?.entry.id).toBe('pyright')
    expect(choice?.executable).toBe(`${masonBin}/pyright-langserver`)
  })

  test('finds nothing when no binary is found', () => {
    expect(chooseLspServer('python', [pyright], [], finder([]))).toBeNull()
  })

  test('skips a server the user turned off', () => {
    const installed = [{ id: 'pyright', kind: 'lsp', enabled: false }]
    expect(chooseLspServer('python', [pyright], installed, finder(['pyright-langserver']))).toBeNull()
  })

  test('prefers the server the user installed', () => {
    const installed = [{ id: 'pylsp', kind: 'lsp', enabled: true }]
    const choice = chooseLspServer('python', [pyright, pylsp], installed, finder(['pyright-langserver', 'pylsp']))
    expect(choice?.entry.id).toBe('pylsp')
  })

  test('ignores servers for other languages', () => {
    expect(chooseLspServer('rust', [pyright], [], finder(['pyright-langserver']))).toBeNull()
  })
})
