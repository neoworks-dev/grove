// Editor extensions catalog: tree-sitter grammars, color themes, and LSP
// servers. The catalog is a curated manifest (grammar wasm from tree-sitter-wasms
// on jsDelivr, highlight queries from nvim-treesitter). Installing a grammar
// downloads its wasm + highlights into userData; themes/LSP entries are metadata.
// Installed set is persisted app-globally in state.

import { app } from 'electron'
import { readFile, writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { loadState, saveState } from './state'
import type { CatalogEntry, InstalledExtension } from '../shared/types'

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out'
const QUERY_BASE = 'https://cdn.jsdelivr.net/gh/nvim-treesitter/nvim-treesitter/queries'

function grammar(
  id: string,
  extensions: string[],
  name: string,
  queryLang = id
): CatalogEntry {
  return {
    id,
    kind: 'grammar',
    name,
    description: `Tree-sitter grammar for ${name}`,
    license: 'MIT',
    extensions,
    wasmUrl: `${WASM_BASE}/tree-sitter-${id}.wasm`,
    highlightsUrl: `${QUERY_BASE}/${queryLang}/highlights.scm`
  }
}

// Curated seed catalog. (A remote manifest could augment this later.)
const SEED: CatalogEntry[] = [
  grammar('python', ['py', 'pyi'], 'Python'),
  grammar('rust', ['rs'], 'Rust'),
  grammar('go', ['go'], 'Go'),
  grammar('javascript', ['js', 'mjs', 'cjs', 'jsx'], 'JavaScript'),
  grammar('typescript', ['ts', 'mts', 'cts'], 'TypeScript'),
  grammar('tsx', ['tsx'], 'TSX'),
  grammar('c', ['c', 'h'], 'C'),
  grammar('cpp', ['cpp', 'hpp', 'cc', 'cxx'], 'C++'),
  grammar('bash', ['sh', 'bash', 'zsh'], 'Shell'),
  grammar('ruby', ['rb'], 'Ruby'),
  grammar('java', ['java'], 'Java'),
  grammar('lua', ['lua'], 'Lua'),
  grammar('html', ['html', 'htm'], 'HTML'),
  grammar('css', ['css', 'scss'], 'CSS'),
  grammar('yaml', ['yml', 'yaml'], 'YAML'),
  grammar('toml', ['toml'], 'TOML'),
  {
    id: 'theme-nord',
    kind: 'theme',
    name: 'Nord',
    description: 'Cool blue-grey dark theme',
    scheme: 'dark',
    palette: {
      bg: '#2e3440',
      bgElevated: '#2b303b',
      surface: '#3b4252',
      surfaceRaised: '#434c5e',
      surfaceHover: '#434c5e',
      surfaceInput: '#292e39',
      border: '#434c5e',
      text: '#eceff4',
      textMuted: '#d8dee9',
      primary: '#88c0d0',
      primaryFg: '#2e3440',
      ctxBlue: '#81a1c1',
      ctxGreen: '#a3be8c',
      ctxAmber: '#ebcb8b',
      ctxRed: '#bf616a',
      ctxViolet: '#b48ead'
    }
  },
  {
    id: 'theme-gruvbox',
    kind: 'theme',
    name: 'Gruvbox',
    description: 'Warm retro dark theme',
    scheme: 'dark',
    palette: {
      bg: '#282828',
      bgElevated: '#1d2021',
      surface: '#3c3836',
      surfaceRaised: '#504945',
      surfaceHover: '#504945',
      surfaceInput: '#232323',
      border: '#504945',
      text: '#ebdbb2',
      textMuted: '#d5c4a1',
      primary: '#fabd2f',
      primaryFg: '#282828',
      ctxBlue: '#83a598',
      ctxGreen: '#b8bb26',
      ctxAmber: '#fabd2f',
      ctxRed: '#fb4934',
      ctxViolet: '#d3869b'
    }
  },
  {
    id: 'typescript-language-server',
    kind: 'lsp',
    name: 'TypeScript / JavaScript LSP',
    description: 'typescript-language-server (must be on PATH)',
    lsp: {
      command: 'typescript-language-server',
      args: ['--stdio'],
      languages: ['typescript', 'javascript'],
      install: 'npm i -g typescript-language-server typescript'
    }
  },
  {
    id: 'pyright',
    kind: 'lsp',
    name: 'Pyright (Python LSP)',
    description: 'pyright-langserver (must be on PATH)',
    lsp: {
      command: 'pyright-langserver',
      args: ['--stdio'],
      languages: ['python'],
      install: 'npm i -g pyright'
    }
  }
]

export function listCatalog(): CatalogEntry[] {
  return SEED
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return SEED.find((entry) => entry.id === id)
}

function extDir(id: string): string {
  return join(app.getPath('userData'), 'extensions', id)
}

export async function listInstalled(): Promise<InstalledExtension[]> {
  const state = await loadState()
  return state.extensions || []
}

async function writeInstalled(list: InstalledExtension[]): Promise<void> {
  const state = await loadState()
  state.extensions = list
  await saveState(state)
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`)
  return response.text()
}

export async function install(id: string): Promise<InstalledExtension> {
  const entry = catalogEntry(id)
  if (!entry) throw new Error(`unknown extension: ${id}`)

  if (entry.kind === 'grammar') {
    const dir = extDir(id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'grammar.wasm'), await fetchBuffer(entry.wasmUrl!))
    // Highlights are best-effort — a grammar with no query still parses.
    const highlights = await fetchText(entry.highlightsUrl!).catch(() => '')
    await writeFile(join(dir, 'highlights.scm'), highlights, 'utf8')
  }

  const installed: InstalledExtension = { id, kind: entry.kind, enabled: true }
  const list = await listInstalled()
  await writeInstalled([...list.filter((entry) => entry.id !== id), installed])
  return installed
}

export async function uninstall(id: string): Promise<void> {
  await rm(extDir(id), { recursive: true, force: true }).catch(() => {})
  const list = await listInstalled()
  await writeInstalled(list.filter((entry) => entry.id !== id))
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  const list = await listInstalled()
  await writeInstalled(list.map((entry) => (entry.id === id ? { ...entry, enabled } : entry)))
}

// Grammar bytes + highlights for the renderer to load into tree-sitter.
export async function readGrammar(
  id: string
): Promise<{ wasm: Uint8Array; highlights: string } | null> {
  try {
    const dir = extDir(id)
    const wasm = await readFile(join(dir, 'grammar.wasm'))
    const highlights = await readFile(join(dir, 'highlights.scm'), 'utf8').catch(() => '')
    return { wasm: new Uint8Array(wasm), highlights }
  } catch {
    return null
  }
}
