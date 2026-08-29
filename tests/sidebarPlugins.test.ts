// The sidebar is a host plugin directory (`kernel/plugins/sidebar/`) and every
// view it shows is a sibling plugin directory that injects it. Renderer plugins
// import `.svelte` components, which bun cannot compile, so this pins the split
// at the source level instead of mounting the plugins: contributors stay
// directories, they declare the dependency, they are in the core set, and the
// rail-launcher registry stays private to the host.

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const RENDERER = join(import.meta.dir, '..', 'src', 'renderer', 'src')
const PLUGINS = join(RENDERER, 'kernel', 'plugins')

/** Every entry under kernel/plugins/, split into directories and loose modules. */
function pluginEntries(): { directories: string[]; modules: string[] } {
  const entries = readdirSync(PLUGINS)
  const directories = entries.filter((entry) => statSync(join(PLUGINS, entry)).isDirectory())
  const modules = entries.filter((entry) => entry.endsWith('.ts') && entry !== 'index.ts')
  return { directories, modules }
}

/** Walk the renderer source tree, yielding every TypeScript and Svelte file. */
function rendererSources(directory: string = RENDERER): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      found.push(...rendererSources(path))
      continue
    }
    if (entry.endsWith('.ts') || entry.endsWith('.svelte')) found.push(path)
  }
  return found
}

/** Files that call into the sidebar service to contribute a view. */
function viewContributors(): string[] {
  const { directories } = pluginEntries()
  return directories.filter((name) => {
    if (name === 'sidebar') return false
    const source = readFileSync(join(PLUGINS, name, 'index.ts'), 'utf8')
    return source.includes('ctx.sidebar.registerView')
  })
}

describe('sidebar plugin split', () => {
  it('keeps the host surface in its own directory', () => {
    const files = readdirSync(join(PLUGINS, 'sidebar')).sort()
    expect(files).toEqual(['ActivityBar.svelte', 'index.ts', 'launchers.svelte.ts'])
  })

  it('gives every sidebar view its own plugin directory', () => {
    expect(viewContributors().sort()).toEqual([
      'agents',
      'checkpoints',
      'explorer',
      'extensions',
      'gitChanges',
      'setup',
      'worktrees'
    ])

    // A loose module can no longer contribute a view: it would have nowhere to
    // put the component it registers.
    const loose = pluginEntries().modules.filter((name) =>
      readFileSync(join(PLUGINS, name), 'utf8').includes('ctx.sidebar.')
    )
    expect(loose).toEqual([])
  })

  it('makes every contributor declare the dependency and join the core set', () => {
    const corePlugins = readFileSync(join(PLUGINS, 'index.ts'), 'utf8')
    for (const name of viewContributors()) {
      const source = readFileSync(join(PLUGINS, name, 'index.ts'), 'utf8')
      expect(source).toMatch(/inject:\s*\[[^\]]*'sidebar'/)
      expect(corePlugins).toContain(`from './${name}'`)
    }
  })

  it('keeps the rail-launcher registry private to the host', () => {
    const outsiders = rendererSources()
      .filter((path) => !path.includes(join('plugins', 'sidebar')))
      .filter((path) => readFileSync(path, 'utf8').includes('sidebar/launchers'))
    expect(outsiders).toEqual([])
  })
})
