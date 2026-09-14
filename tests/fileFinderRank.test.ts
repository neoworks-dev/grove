import { describe, it, expect } from 'bun:test'
import { rankFiles, scoreCandidate } from '../resources/plugins/grove.file-finder/src/rank'

const paths = [
  'src/renderer/src/kernel/plugins/agents/agent/AgentComposer.svelte',
  'src/renderer/src/components/AgentLogo.svelte',
  'src/main/agents/service.ts',
  'src/main/files.ts',
  'tests/files.test.ts'
]

describe('rankFiles', () => {
  it('matches initials scattered through a filename', () => {
    expect(rankFiles(paths, 'acomp')[0]).toBe(
      'src/renderer/src/kernel/plugins/agents/agent/AgentComposer.svelte'
    )
  })

  it('keeps matching substrings the way it always did', () => {
    expect(rankFiles(paths, 'agentcomposer')).toEqual([
      'src/renderer/src/kernel/plugins/agents/agent/AgentComposer.svelte'
    ])
  })

  it('ranks a filename hit above the same letters spread over directories', () => {
    expect(rankFiles(paths, 'files')[0]).toBe('src/main/files.ts')
  })

  it('prefers the shorter path when two filenames match equally well', () => {
    expect(rankFiles(paths, 'files.ts')).toEqual(['src/main/files.ts', 'tests/files.test.ts'])
  })

  it('matches on directories too', () => {
    expect(rankFiles(paths, 'main/service')).toEqual(['src/main/agents/service.ts'])
  })

  it('drops paths the query is not a subsequence of', () => {
    expect(rankFiles(paths, 'zzz')).toEqual([])
  })

  it('returns everything, in order, for an empty query', () => {
    expect(rankFiles(paths, '   ')).toEqual(paths)
  })

  it('is case-insensitive', () => {
    expect(rankFiles(paths, 'AGENTLOGO')).toEqual(['src/renderer/src/components/AgentLogo.svelte'])
  })

  it('does not cap its results', () => {
    const many = Array.from({ length: 1000 }, (_, index) => `src/file${index}.ts`)
    expect(rankFiles(many, 'file').length).toBe(1000)
  })
})

describe('scoreCandidate', () => {
  it('returns null when the needle is not a subsequence', () => {
    expect(scoreCandidate('src/main/files.ts', 'qqq')).toBeNull()
  })

  it('scores an adjacent run above a scattered match', () => {
    const adjacent = scoreCandidate('src/composer.ts', 'comp')
    const scattered = scoreCandidate('src/collect-my-parts.ts', 'comp')
    expect(adjacent).not.toBeNull()
    expect(scattered).not.toBeNull()
    expect(adjacent!).toBeGreaterThan(scattered!)
  })
})
