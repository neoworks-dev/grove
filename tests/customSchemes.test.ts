// Electron keeps only the last registerSchemesAsPrivileged call: a second one
// replaces the first's list, and the scheme it drops quietly loses fetch and
// CORS — plugin workers stop loading, attachments stop showing. Pinned at the
// source level, since the loss only shows in a running app.

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const MAIN = join(import.meta.dir, '..', 'src', 'main')

/** Every TypeScript file under a directory, recursively. */
function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path))
      continue
    }
    if (path.endsWith('.ts')) files.push(path)
  }
  return files
}

describe('custom schemes', () => {
  it('are declared privileged in a single call', () => {
    const calls = sourceFiles(MAIN).flatMap((file) => {
      const count = readFileSync(file, 'utf8').split('registerSchemesAsPrivileged(').length - 1
      return Array.from({ length: count }, () => file)
    })
    expect(calls).toEqual([join(MAIN, 'index.ts')])
  })
})
