// Fetch the pinned Neovim release for the current (or NVIM_TARGET) platform
// into resources/nvim/dist/<platform>-<arch>/. The binary is vendored at
// build/install time instead of committed — the extracted tree is ~40MB.
// Offline-tolerant: a failed download warns and exits 0 so `bun install`
// works without network; the nvim pane then shows a "runtime missing" hint.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const NVIM_VERSION = '0.12.4'

interface NvimAsset {
  file: string
  sha256: string
}

// Official digests from the GitHub release (api digest field, v0.12.4).
const ASSETS: Record<string, NvimAsset> = {
  'linux-x64': {
    file: 'nvim-linux-x86_64.tar.gz',
    sha256: '012bf3fcac5ade43914df3f174668bf64d05e049a4f032a388c027b1ebd78628'
  },
  'linux-arm64': {
    file: 'nvim-linux-arm64.tar.gz',
    sha256: 'ceb7e88c6b681f0515d135dcdfad54f5eb4373b25ce6172197cd9a69c758063f'
  },
  'darwin-arm64': {
    file: 'nvim-macos-arm64.tar.gz',
    sha256: '51ab83afa66d663627c2ab1be43209b0f4e81360d4598b53efaa4d8195f24c89'
  },
  'darwin-x64': {
    file: 'nvim-macos-x86_64.tar.gz',
    sha256: '03fe16f8dd9f1e9eaf52d5e294913a39917b9e2faea30d7fb0fb385fbd36fe59'
  },
  'win32-x64': {
    file: 'nvim-win64.zip',
    sha256: '9fc3572829ffd13debb6e32555da2c8cc02555568260a9fc4cf1f65bbcca319c'
  }
}

const target = process.env.NVIM_TARGET ?? `${process.platform}-${process.arch}`
const asset = ASSETS[target]
const rootDir = join(import.meta.dirname, '..', 'resources', 'nvim', 'dist')
const targetDir = join(rootDir, target)
const stampPath = join(rootDir, `.stamp-v${NVIM_VERSION}-${target}`)

function fail(message: string): never {
  console.warn(`fetch-nvim: ${message}`)
  console.warn('fetch-nvim: the embedded Neovim pane will be unavailable until this succeeds.')
  process.exit(0)
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

function extract(archivePath: string, destination: string): void {
  const isZip = archivePath.endsWith('.zip')
  const result = isZip
    ? spawnSync('unzip', ['-q', archivePath, '-d', destination])
    : spawnSync('tar', ['xzf', archivePath, '-C', destination, '--strip-components=1'])
  if (result.status !== 0) {
    throw new Error(`extract failed: ${result.stderr?.toString() ?? 'unknown error'}`)
  }
  if (!isZip) return
  // The zip contains a single nvim-win64/ root; flatten it like --strip-components.
  const inner = join(destination, 'nvim-win64')
  if (existsSync(inner)) {
    spawnSync(process.platform === 'win32' ? 'robocopy' : 'cp', ['-r', `${inner}/.`, destination])
  }
}

async function main(): Promise<void> {
  if (!asset) fail(`no pinned asset for target "${target}"`)
  if (existsSync(stampPath) && existsSync(targetDir)) {
    console.log(`fetch-nvim: v${NVIM_VERSION} for ${target} already present`)
    return
  }

  const url = `https://github.com/neovim/neovim/releases/download/v${NVIM_VERSION}/${asset.file}`
  console.log(`fetch-nvim: downloading ${url}`)
  let archive: Buffer
  try {
    archive = await download(url)
  } catch (error) {
    fail(`download failed (${String(error)})`)
  }

  const digest = createHash('sha256').update(archive).digest('hex')
  if (digest !== asset.sha256) {
    fail(`checksum mismatch for ${asset.file}: got ${digest}`)
  }

  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })
  const archivePath = join(rootDir, asset.file)
  await writeFile(archivePath, archive)
  try {
    extract(archivePath, targetDir)
  } finally {
    await rm(archivePath, { force: true })
  }
  await mkdir(dirname(stampPath), { recursive: true })
  await writeFile(stampPath, `${new Date().toISOString()}\n`)
  console.log(`fetch-nvim: installed v${NVIM_VERSION} to ${targetDir}`)
}

await main()
