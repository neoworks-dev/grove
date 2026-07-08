// Settings schema + payload types shared by main, preload, renderer, and the
// plugin SDK. Schemas live in the renderer (base app + plugins register them);
// the main process is a schema-free persistence layer over two JSON files:
//   user scope    <userData>/settings.json
//   project scope <repo>/.workbench/settings.json   (overrides user)
// Values are stored as flat dotted keys so the files stay human-editable.

export type SettingScope = 'user' | 'project'

export type SettingType = 'string' | 'number' | 'boolean' | 'enum' | 'keybind' | 'color'

export interface SettingEnumValue {
  value: string
  label: string
}

export interface SettingDefinition {
  // Full dotted key, '<contributorId>.<name>', e.g. 'appearance.colorTheme'.
  key: string
  type: SettingType
  default: unknown
  title: string
  description?: string
  // Sub-grouping inside a contributor section of the preferences pane.
  category?: string
  enumValues?: SettingEnumValue[]
  minimum?: number
  maximum?: number
  // Omitted = allowed in both scopes; the UI hides disallowed scopes.
  scopes?: SettingScope[]
}

export interface SettingsContribution {
  // 'workbench' for the base app, the plugin id for plugins.
  contributorId: string
  // Section heading in the preferences pane.
  title: string
  settings: SettingDefinition[]
}

export interface SettingsSnapshot {
  user: Record<string, unknown>
  // {} when no repo is open.
  project: Record<string, unknown>
}
