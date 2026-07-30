// Compile the nib agent server into resources/nib/dist/<platform>-<arch>/ for a
// packaged build. Development runs nib from a sibling checkout through bun
// instead, so this only matters when producing a distributable.
//
// Offline- and absence-tolerant in the same way as fetch-nvim: a missing
// checkout warns and exits 0 so `npm run build` still works, and the agent pane
// then reports the runtime as missing rather than the build failing outright.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const target = process.env.NIB_TARGET ?? `${process.platform}-${process.arch}`
const rootDir = join(import.meta.dirname, '..', 'resources', 'nib', 'dist')
const targetDir = join(rootDir, target)
const binaryName = target.startsWith('win32') ? 'nib-server.exe' : 'nib-server'
const binaryPath = join(targetDir, binaryName)

/** Where nib's source lives. GROVE_NIB wins, else the sibling checkout. */
function checkoutPath(): string {
  const configured = process.env.GROVE_NIB
  if (configured) return resolve(configured)
  return join(import.meta.dirname, '..', '..', 'neoworks', 'nib')
}

function fail(message: string): never {
  console.warn(`build-nib: ${message}`)
  console.warn('build-nib: the packaged build will have no agent server.')
  process.exit(0)
}

function revisionOf(checkout: string): string {
  const result = spawnSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (result.status !== 0) return 'unknown'
  return result.stdout.trim()
}

async function main(): Promise<void> {
  const checkout = checkoutPath()
  const entry = join(checkout, 'src', 'index.ts')
  if (!existsSync(entry)) fail(`no nib checkout at ${checkout} (set GROVE_NIB)`)

  // Rebuilding is cheap, but not free — skip when the compiled binary already
  // matches the checkout's current revision.
  const revision = revisionOf(checkout)
  const stampPath = join(rootDir, `.stamp-${target}`)
  if (existsSync(binaryPath) && existsSync(stampPath)) {
    const stamped = await readFile(stampPath, 'utf8')
    if (stamped.trim() === revision && revision !== 'unknown') {
      console.log(`build-nib: ${revision.slice(0, 8)} for ${target} already built`)
      return
    }
  }

  await mkdir(targetDir, { recursive: true })
  console.log(`build-nib: compiling ${entry} → ${binaryPath}`)
  const result = spawnSync('bun', ['build', '--compile', entry, '--outfile', binaryPath], {
    cwd: checkout,
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    await rm(binaryPath, { force: true })
    fail('bun build --compile failed')
  }

  await writeFile(stampPath, `${revision}\n`)
  console.log(`build-nib: built ${revision.slice(0, 8)} for ${target}`)
}

await main()
