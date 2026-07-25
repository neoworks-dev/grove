import { describe, it, expect } from 'bun:test'
import { load } from 'js-yaml'
import { renderConfig } from '../src/main/configRender'
import { applyDefaults } from '../src/main/config'
import type { WorkbenchConfig } from '../src/shared/types'

const FULL: WorkbenchConfig = {
  workbench: { worktrees_dir: '../.worktrees', default_base_branch: 'main' },
  ports: { start: 3100, count_per_worktree: 10 },
  setup: { once: ['bun install'], per_worktree: ['bun install'] },
  services: {
    web: {
      command: 'bun run dev -- --port ${PORT_0}',
      preview: 'http://localhost:${PORT_0}',
      health: 'http://localhost:${PORT_0}',
      log: 'web.log'
    },
    api: { command: 'PORT=${PORT_0} make serve' }
  },
  agents: { claude: { command: 'claude' } }
}

describe('renderConfig', () => {
  it('round-trips through the YAML parser back to the same config', () => {
    const parsed = applyDefaults(load(renderConfig(FULL)))
    expect(parsed).toEqual(FULL)
  })

  it('round-trips an empty config', () => {
    const empty = applyDefaults({})
    expect(applyDefaults(load(renderConfig(empty)))).toEqual(empty)
  })

  it('omits optional service fields rather than writing them empty', () => {
    const text = renderConfig(FULL)
    const apiBlock = text.slice(text.indexOf('  api:'))
    expect(apiBlock).not.toContain('preview:')
    expect(apiBlock).not.toContain('log:')
  })

  it('leaves port placeholders unquoted and readable', () => {
    expect(renderConfig(FULL)).toContain('command: bun run dev -- --port ${PORT_0}')
  })

  it('keeps the explanatory comments a hand-edited file needs', () => {
    const text = renderConfig(FULL)
    expect(text).toContain('# Each worktree gets a contiguous block of ports')
    expect(text).toContain('# Long-running processes Grove supervises per worktree.')
  })

  it('writes empty collections as {} and [] so the shape stays visible', () => {
    const text = renderConfig(applyDefaults({}))
    expect(text).toContain('services: {}')
    expect(text).toContain('agents: {}')
    expect(text).toContain('once: []')
  })

  it('quotes values YAML would otherwise reinterpret', () => {
    const tricky = applyDefaults({
      services: { odd: { command: 'echo "hi: there"  ' } }
    })
    const parsed = applyDefaults(load(renderConfig(tricky))) as WorkbenchConfig
    expect(parsed.services.odd.command).toBe('echo "hi: there"  ')
  })

  it('ends with a trailing newline', () => {
    expect(renderConfig(FULL).endsWith('\n')).toBe(true)
  })
})
