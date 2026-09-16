// Playwright's global setup: make sure there is a build to launch.
//
// The e2e suite runs the packaged main process (`out/main/index.js`) rather
// than the dev server, so what is tested is what ships. Building takes a while,
// so a run that only changes a test can skip it with GROVE_E2E_SKIP_BUILD=1.

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Playwright transpiles to CommonJS, where `import.meta` is unavailable. It
// also resolves its config from the repo root and runs there, so cwd is it.
const repoRoot = process.cwd()

export default async function build(): Promise<void> {
  if (process.env.GROVE_E2E_SKIP_BUILD === '1' && (await hasBuild())) {
    console.log('e2e: reusing the existing build')
    return
  }
  console.log('e2e: building the app (GROVE_E2E_SKIP_BUILD=1 to reuse the last one)…')
  await run('npm', ['run', 'build'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
}

async function hasBuild(): Promise<boolean> {
  try {
    await stat(join(repoRoot, 'out', 'main', 'index.js'))
    return true
  } catch {
    return false
  }
}
