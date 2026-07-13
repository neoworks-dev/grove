// File-icon resolution with pluggable icon packs. A pack maps a filename to an
// Iconify icon id (e.g. "vscode-icons:file-type-typescript"). Collections are
// registered offline via addCollection so no network is needed. Add another
// @iconify-json/* collection + a Pack here to support a different icon style.

import { addCollection } from '@iconify/svelte'
import vscodeIcons from '@iconify-json/vscode-icons/icons.json'
import materialIcons from '@iconify-json/material-icon-theme/icons.json'

export interface IconPack {
  name: string
  label: string
  file: (name: string) => string
  folder: (name: string, expanded: boolean) => string
}

// Extension → vscode-icons "file-type-*" suffix. Covers common types; anything
// unmapped falls back to the default file icon.
const VSCODE_EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'reactts', js: 'js', mjs: 'js', cjs: 'js', jsx: 'reactjs',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'scss', sass: 'scss', less: 'css',
  html: 'html', htm: 'html', svelte: 'svelte', vue: 'vue',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'text',
  py: 'python', rs: 'rust', go: 'go', rb: 'ruby', php: 'php',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'svg',
  webp: 'image', ico: 'image', txt: 'text', log: 'log'
}

// Special exact filenames → vscode-icons suffix.
const VSCODE_NAME: Record<string, string> = {
  'package.json': 'npm', 'package-lock.json': 'npm', 'bun.lock': 'bun',
  'bun.lockb': 'bun', '.gitignore': 'git', '.gitattributes': 'git',
  'tsconfig.json': 'tsconfig', '.eslintrc': 'eslint', 'eslint.config.mjs': 'eslint',
  '.prettierrc': 'prettier', '.prettierrc.yaml': 'prettier',
  'vite.config.ts': 'vite', 'tailwind.config.js': 'tailwind',
  'dockerfile': 'docker', 'readme.md': 'markdown', '.env': 'text'
}

const vscodePack: IconPack = {
  name: 'vscode-icons',
  label: 'VSCode Icons',
  file(name) {
    const lower = name.toLowerCase()
    if (VSCODE_NAME[lower]) return `vscode-icons:file-type-${VSCODE_NAME[lower]}`
    const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
    const suffix = VSCODE_EXT[ext]
    return suffix ? `vscode-icons:file-type-${suffix}` : 'vscode-icons:default-file'
  },
  folder(_name, expanded) {
    return expanded ? 'vscode-icons:default-folder-opened' : 'vscode-icons:default-folder'
  }
}

// Extension → material-icon-theme icon name. Unmapped extensions fall back to
// the generic document icon.
const MATERIAL_EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'react-ts', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'react',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'sass', sass: 'sass', less: 'less',
  html: 'html', htm: 'html', svelte: 'svelte', vue: 'vue',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'document',
  py: 'python', rs: 'rust', go: 'go', rb: 'ruby', php: 'php',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  sh: 'console', bash: 'console', zsh: 'console', fish: 'console',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'svg',
  webp: 'image', ico: 'image', txt: 'document', log: 'log'
}

// Special exact filenames → material-icon-theme icon name.
const MATERIAL_NAME: Record<string, string> = {
  'package.json': 'npm', 'package-lock.json': 'npm', 'bun.lock': 'bun',
  'bun.lockb': 'bun', '.gitignore': 'git', '.gitattributes': 'git',
  'tsconfig.json': 'tsconfig', '.eslintrc': 'eslint', 'eslint.config.mjs': 'eslint',
  '.prettierrc': 'prettier', '.prettierrc.yaml': 'prettier',
  'vite.config.ts': 'vite', 'tailwind.config.js': 'tailwindcss',
  'dockerfile': 'docker', 'readme.md': 'readme', '.env': 'tune'
}

const materialPack: IconPack = {
  name: 'material-icon-theme',
  label: 'Material Icons',
  file(name) {
    const lower = name.toLowerCase()
    if (MATERIAL_NAME[lower]) return `material-icon-theme:${MATERIAL_NAME[lower]}`
    const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
    const icon = MATERIAL_EXT[ext]
    return icon ? `material-icon-theme:${icon}` : 'material-icon-theme:document'
  },
  folder(_name, expanded) {
    return expanded ? 'material-icon-theme:folder-base-open' : 'material-icon-theme:folder-base'
  }
}

const packs = new Map<string, IconPack>()
packs.set(materialPack.name, materialPack)
packs.set(vscodePack.name, vscodePack)

let activePack = materialPack
let initialized = false

// Register icon collections once. Extend here to add more styles.
export function initIcons(): void {
  if (initialized) return
  addCollection(materialIcons)
  addCollection(vscodeIcons)
  initialized = true
  const saved = localStorage.getItem('iconPack')
  if (saved && packs.has(saved)) activePack = packs.get(saved)!
}

export function availablePacks(): IconPack[] {
  return [...packs.values()]
}

export function setIconPack(name: string): void {
  if (packs.has(name)) {
    activePack = packs.get(name)!
    localStorage.setItem('iconPack', name)
  }
}

export function currentPackName(): string {
  return activePack.name
}

export function fileIcon(name: string): string {
  return activePack.file(name)
}

export function folderIcon(name: string, expanded: boolean): string {
  return activePack.folder(name, expanded)
}
