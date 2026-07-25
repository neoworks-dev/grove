import { describe, it, expect } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pendingStages, nextStage } from '../src/renderer/src/lib/setup/stages'
import { detectServices } from '../src/main/detect'

describe('pendingStages', () => {
  it('offers every stage to a bare repo', () => {
    expect(pendingStages({ hasConfig: false, hasAgentsFile: false })).toEqual([
      'config',
      'agent',
      'agents-md'
    ])
  })

  it('skips the config stage when workbench.yaml already exists', () => {
    expect(pendingStages({ hasConfig: true, hasAgentsFile: false })).toEqual(['agent', 'agents-md'])
  })

  it('skips the AGENTS.md stage when an instruction file already exists', () => {
    expect(pendingStages({ hasConfig: false, hasAgentsFile: true })).toEqual(['config', 'agent'])
  })

  it('still offers the agent stage to a fully configured repo', () => {
    // Choosing a default agent is a preference, not a file we can detect.
    expect(pendingStages({ hasConfig: true, hasAgentsFile: true })).toEqual(['agent'])
  })
})

describe('nextStage', () => {
  const all = pendingStages({ hasConfig: false, hasAgentsFile: false })

  it('walks the stages in order', () => {
    expect(nextStage('config', all)).toBe('agent')
    expect(nextStage('agent', all)).toBe('agents-md')
  })

  it('returns null at the end so the caller finishes', () => {
    expect(nextStage('agents-md', all)).toBe(null)
  })

  it('skips over a stage this repo does not need', () => {
    const configured = pendingStages({ hasConfig: true, hasAgentsFile: false })
    expect(nextStage('agent', configured)).toBe('agents-md')
  })

  it('recovers to the first stage when the current one is not pending', () => {
    // A stale stage left from a previous repo must not strand the wizard.
    const configured = pendingStages({ hasConfig: true, hasAgentsFile: false })
    expect(nextStage('config', configured)).toBe('agent')
  })

  it('returns null when there is nothing to do', () => {
    expect(nextStage('config', [])).toBe(null)
  })
})

describe('detectServices', () => {
  it('reads a real repo and merges proposals from every detector', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grove-detect-'))
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite --port 5173', build: 'vite build' } })
    )
    await writeFile(join(dir, 'bun.lock'), '')
    await writeFile(join(dir, 'Procfile'), 'worker: rake jobs:work\n')

    const proposals = await detectServices(dir)
    const names = proposals.map((proposal) => proposal.name)

    expect(names).toContain('dev')
    expect(names).toContain('worker')
    expect(names).not.toContain('build')
    expect(proposals.find((proposal) => proposal.name === 'dev')?.command).toStartWith(
      'bun run dev'
    )
  })

  it('returns nothing for a repo with no recognisable services', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grove-detect-empty-'))
    await writeFile(join(dir, 'README.md'), 'hello\n')
    expect(await detectServices(dir)).toEqual([])
  })

  it('disambiguates a name two detectors both propose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grove-detect-clash-'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    await writeFile(join(dir, 'Makefile'), 'dev:\n\tgo run .\n')

    const names = (await detectServices(dir)).map((proposal) => proposal.name)

    expect(names).toContain('dev')
    expect(names).toContain('dev-makefile')
    expect(new Set(names).size).toBe(names.length)
  })
})
