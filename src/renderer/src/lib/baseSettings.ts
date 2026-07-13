// Base app settings schemas + one-time migration of legacy localStorage
// values into the settings provider. Wire-up: consumers read settings
// reactively; external file edits propagate through settings.onChange.

import { settings } from './settings.svelte'
import { store, applyColorTheme } from './store.svelte'
import { availableThemes } from './themes'
import { availablePacks, setIconPack } from './icons'

const MIGRATION_MARKER = 'settingsMigrated'

export function registerBaseSettings(): void {
  settings.registerSchemas({
    contributorId: 'workbench',
    title: 'Workbench',
    settings: [
      {
        key: 'workbench.colorTheme',
        type: 'enum',
        default: 'neoworks',
        title: 'Color Theme',
        category: 'Appearance',
        enumValues: availableThemes().map((theme) => ({ value: theme.name, label: theme.label }))
      },
      {
        key: 'workbench.iconPack',
        type: 'enum',
        default: 'vscode-icons',
        title: 'File Icon Theme',
        category: 'Appearance',
        enumValues: availablePacks().map((pack) => ({ value: pack.name, label: pack.label }))
      },
      {
        key: 'workbench.defaultAgent',
        type: 'string',
        default: '',
        title: 'Default Agent',
        description: 'Agent preselected in the agent pane and used by AI keybind actions.',
        category: 'Agents'
      },
      {
        key: 'workbench.whichKeyDelay',
        type: 'number',
        default: 300,
        title: 'Which-Key Delay',
        description: 'Milliseconds before the leader hint overlay appears.',
        category: 'Keyboard',
        minimum: 0,
        maximum: 2000
      },
      {
        key: 'workbench.centerEditor',
        type: 'enum',
        default: 'nvim',
        title: 'Editor',
        description: 'Which editor opens files: embedded Neovim or the built-in CodeMirror pane.',
        category: 'Editor',
        enumValues: [
          { value: 'nvim', label: 'Neovim (embedded)' },
          { value: 'codemirror', label: 'CodeMirror' }
        ]
      },
      {
        key: 'workbench.nvimFontSize',
        type: 'number',
        default: 13,
        title: 'Neovim Font Size',
        description: 'Grid font size in pixels for the embedded Neovim pane.',
        category: 'Editor',
        minimum: 6,
        maximum: 32
      }
    ]
  })
}

interface LegacyMapping {
  key: string
  read: () => unknown | undefined
}

const LEGACY_MAPPINGS: LegacyMapping[] = [
  { key: 'workbench.colorTheme', read: () => localStorage.getItem('colorTheme') ?? undefined },
  { key: 'workbench.iconPack', read: () => localStorage.getItem('iconPack') ?? undefined },
  {
    key: 'workbench.defaultAgent',
    read: () => localStorage.getItem('agent.selected') ?? undefined
  }
]

// Copy legacy localStorage values into user-scope settings once. The old keys
// stay in localStorage (downgrade safety) but are never read again.
async function migrateLegacyValues(): Promise<void> {
  if (localStorage.getItem(MIGRATION_MARKER) === '1') return
  for (const mapping of LEGACY_MAPPINGS) {
    if (settings.raw(mapping.key, 'user') !== undefined) continue
    const value = mapping.read()
    if (value === undefined) continue
    await settings.set(mapping.key, value, 'user')
  }
  localStorage.setItem(MIGRATION_MARKER, '1')
}

// Apply current values and react to future changes (preferences pane edits or
// hand-edited settings files). Theme/icons were already applied from
// localStorage at boot, so the re-apply here is idempotent and flash-free.
export async function applyBaseSettings(): Promise<void> {
  await migrateLegacyValues()

  const theme = settings.get<string>('workbench.colorTheme')
  if (theme && theme !== store.colorTheme) applyColorTheme(theme)
  settings.onChange('workbench.colorTheme', (value) => {
    if (typeof value === 'string') applyColorTheme(value)
  })

  const pack = settings.get<string>('workbench.iconPack')
  if (pack && pack !== store.iconPack) applyPack(pack)
  settings.onChange('workbench.iconPack', (value) => {
    if (typeof value === 'string') applyPack(value)
  })
}

function applyPack(name: string): void {
  setIconPack(name)
  store.iconPack = name
}
