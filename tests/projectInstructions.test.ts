import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, symlink, link } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  NestedInstructions,
  mergeInstructions,
  readDirectoryInstructions,
  rootInstructionsSection,
  withNestedInstructions
} from '../src/main/agents/projectInstructions'
import type { GroveTool, GroveToolContext } from '../src/main/agents/harness'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'grove-instructions-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const RULES = '# Rules\n\n- Use bun\n- Never poll\n'

describe('reading a directory', () => {
  it('has nothing to say without either file', async () => {
    expect(await readDirectoryInstructions(root)).toBeNull()
    expect(await rootInstructionsSection(root)).toBe('')
  })

  it('reads a lone file', async () => {
    await writeFile(join(root, 'CLAUDE.md'), RULES)
    expect(await readDirectoryInstructions(root)).toEqual({ files: ['CLAUDE.md'], text: RULES.trim() })
  })

  it('reads a symlinked pair once', async () => {
    await writeFile(join(root, 'AGENTS.md'), RULES)
    await symlink('AGENTS.md', join(root, 'CLAUDE.md'))
    expect(await readDirectoryInstructions(root)).toEqual({
      files: ['AGENTS.md', 'CLAUDE.md'],
      text: RULES.trim()
    })
  })

  it('reads a hard-linked pair once', async () => {
    await writeFile(join(root, 'AGENTS.md'), RULES)
    await link(join(root, 'AGENTS.md'), join(root, 'CLAUDE.md'))
    expect((await readDirectoryInstructions(root))?.text).toBe(RULES.trim())
  })

  it("reads a CLAUDE.md that only imports AGENTS.md once", async () => {
    await writeFile(join(root, 'AGENTS.md'), RULES)
    await writeFile(join(root, 'CLAUDE.md'), '@AGENTS.md\n')
    expect((await readDirectoryInstructions(root))?.text).toBe(RULES.trim())
  })

  it('keeps what an importing CLAUDE.md adds, marked as its own', async () => {
    await writeFile(join(root, 'AGENTS.md'), RULES)
    await writeFile(join(root, 'CLAUDE.md'), '@./AGENTS.md\n\n- Claude: prefer the grove tools\n')
    expect((await readDirectoryInstructions(root))?.text).toBe(
      [
        '# Rules',
        '',
        '- Use bun',
        '- Never poll',
        '',
        '[only in CLAUDE.md]',
        '- Claude: prefer the grove tools',
        '[/only in CLAUDE.md]'
      ].join('\n')
    )
  })
})

describe('merging two that drifted apart', () => {
  it('says shared lines once and marks each side where they disagree', () => {
    const agents = '# Rules\n\n- Use bun\n- Never poll\n- Ask before committing\n'
    const claude = '# Rules\n\n- Use npm\n- Never poll\n- Ask before committing\n- Keep diffs small\n'
    expect(mergeInstructions('AGENTS.md', agents, 'CLAUDE.md', claude)).toBe(
      [
        '# Rules',
        '',
        '[only in AGENTS.md]',
        '- Use bun',
        '[/only in AGENTS.md]',
        '[only in CLAUDE.md]',
        '- Use npm',
        '[/only in CLAUDE.md]',
        '- Never poll',
        '- Ask before committing',
        '[only in CLAUDE.md]',
        '- Keep diffs small',
        '[/only in CLAUDE.md]'
      ].join('\n')
    )
  })

  it('treats trailing whitespace and blank-line drift as the same text', () => {
    expect(mergeInstructions('A', '- one  \n- two\n', 'B', '- one\n- two\n\n\n')).toBe('- one\n- two')
  })

  it('costs less than both files together', () => {
    const shared = Array.from({ length: 50 }, (_, index) => `- rule ${index}`).join('\n')
    const merged = mergeInstructions('A', `${shared}\n- only a`, 'B', `${shared}\n- only b`)
    expect(merged.length).toBeLessThan(shared.length * 1.2)
    expect(merged).toContain('- only a')
    expect(merged).toContain('- only b')
  })
})

describe('two different documents', () => {
  it('serves each whole instead of chopping them into each other', () => {
    const agents = '# Plugin SDK\n\n- Everything is async\n- No closed unions\n'
    const claude = '## Git\n\n- Commit when dirty\n- No trailers\n- Short titles\n'
    expect(mergeInstructions('AGENTS.md', agents, 'CLAUDE.md', claude)).toBe(
      [
        '[AGENTS.md]',
        '# Plugin SDK',
        '',
        '- Everything is async',
        '- No closed unions',
        '[/AGENTS.md]',
        '',
        '[CLAUDE.md]',
        '## Git',
        '',
        '- Commit when dirty',
        '- No trailers',
        '- Short titles',
        '[/CLAUDE.md]'
      ].join('\n')
    )
  })
})

describe('instructions further down', () => {
  const context = (): GroveToolContext => ({ sessionId: 's', workspaceRoot: root }) as GroveToolContext

  async function layout(): Promise<void> {
    await writeFile(join(root, 'AGENTS.md'), '- root rule\n')
    await mkdir(join(root, 'api', 'src'), { recursive: true })
    await writeFile(join(root, 'api', 'AGENTS.md'), '- api rule\n')
    await writeFile(join(root, 'api', 'src', 'CLAUDE.md'), '- src rule\n')
    await writeFile(join(root, 'api', 'src', 'index.ts'), 'export {}\n')
  }

  it('hands over every directory on the way down once, and never the root', async () => {
    await layout()
    const nested = new NestedInstructions(() => [root])
    const first = await nested.forPath(root, join(root, 'api', 'src', 'index.ts'))
    expect(first).toContain('<project_instructions path="api">')
    expect(first).toContain('- api rule')
    expect(first).toContain('<project_instructions path="api/src">')
    expect(first).toContain('- src rule')
    expect(first).not.toContain('- root rule')
    expect(await nested.forPath(root, join(root, 'api', 'src'))).toBe('')
  })

  it("includes another worktree's root, which isn't in the system prompt", async () => {
    await layout()
    const other = await mkdtemp(join(tmpdir(), 'grove-other-'))
    try {
      await writeFile(join(other, 'AGENTS.md'), '- other rule\n')
      const nested = new NestedInstructions(() => [root, other])
      expect(await nested.forPath(root, join(other, 'file.ts'))).toContain('- other rule')
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('adds them to the first tool result that works there', async () => {
    await layout()
    const read: GroveTool = {
      name: 'read',
      summary: 'Read a file',
      inputSchema: { type: 'object' },
      execute: () => ({ content: 'file contents' })
    } as unknown as GroveTool
    const [wrapped] = withNestedInstructions([read], new NestedInstructions(() => [root]))
    const first = await wrapped.execute({ path: 'api/src/index.ts' }, context())
    expect(first.content.startsWith('file contents\n\n<project_instructions path="api">')).toBe(true)
    const again = await wrapped.execute({ path: 'api/src/index.ts' }, context())
    expect(again.content).toBe('file contents')
  })

  it('leaves tools without a path, and failed calls, alone', async () => {
    await layout()
    const failing = {
      name: 'read',
      execute: () => ({ content: 'no such file', isError: true })
    } as unknown as GroveTool
    const shell = { name: 'shell', execute: () => ({ content: 'ok' }) } as unknown as GroveTool
    const [readTool, shellTool] = withNestedInstructions(
      [failing, shell],
      new NestedInstructions(() => [root])
    )
    expect((await readTool.execute({ path: 'api/x.ts' }, context())).content).toBe('no such file')
    expect(shellTool).toBe(shell)
  })
})
