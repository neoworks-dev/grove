// What a new worktree gets beyond git's checkout: the main worktree's untracked
// env files.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { execSync } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  copyEnvFiles,
  isEnvFile,
  untrackedEnvFiles
} from '../src/main/worktreeBootstrap'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'grove-bootstrap-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A git repo with an ignored `.env`, an untracked `.env.local`, and an ignored node_modules. */
function repoWithEnvFiles(): string {
  const repo = join(root, 'main')
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules\n')
  writeFileSync(join(repo, '.env'), 'SECRET=1\n')
  writeFileSync(join(repo, '.env.local'), 'LOCAL=1\n')
  writeFileSync(join(repo, 'apps', 'web', '.env'), 'WEB=1\n')
  writeFileSync(join(repo, 'node_modules', 'pkg', '.env'), 'NOT_OURS=1\n')
  writeFileSync(join(repo, '.env.example'), 'SECRET=\n')
  execSync(
    'git init -q && git add .gitignore .env.example && git -c user.name=t -c user.email=t@t commit -q -m init',
    { cwd: repo }
  )
  return repo
}

describe('isEnvFile', () => {
  it('matches .env and its variants, anywhere', () => {
    expect(isEnvFile('.env')).toBe(true)
    expect(isEnvFile('apps/web/.env.local')).toBe(true)
    expect(isEnvFile('.envrc')).toBe(false)
    expect(isEnvFile('env.ts')).toBe(false)
  })
})

describe('untrackedEnvFiles', () => {
  it('lists ignored and untracked env files, not tracked ones or ones inside ignored directories', async () => {
    const repo = repoWithEnvFiles()
    const files = (await untrackedEnvFiles(repo)).sort()
    expect(files).toEqual(['.env', '.env.local', 'apps/web/.env'])
  })
})

describe('copyEnvFiles', () => {
  it('copies them at the same relative paths, keeping what the worktree already has', async () => {
    const repo = repoWithEnvFiles()
    const worktree = join(root, 'worktree')
    mkdirSync(worktree)
    writeFileSync(join(worktree, '.env.local'), 'MINE=1\n')
    const lines: string[] = []

    await copyEnvFiles(repo, worktree, (line) => lines.push(line))

    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('SECRET=1\n')
    expect(readFileSync(join(worktree, 'apps', 'web', '.env'), 'utf8')).toBe('WEB=1\n')
    expect(readFileSync(join(worktree, '.env.local'), 'utf8')).toBe('MINE=1\n')
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false)
    expect(lines).toHaveLength(2)
  })
})
