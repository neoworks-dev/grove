// Vendored from nib (web/src/renderer/lib/state/catalog.svelte.ts), reformatted to
// grove's style and repointed at the vendored api module.
/**
 * What the server offers: tools, commands, skills and models.
 *
 * None of it changes during a session unless an extension is reloaded, so it is fetched once and
 * shared. Several parts of the UI want the same lists — the composer completes commands, the
 * approval card needs a tool's schema, the palette needs models — and none should fetch its own.
 */

import { listCommands, listModels, listSkills, listTools } from './api'
import type { CommandInfo, ProviderModels, SkillInfo, ToolInfo } from './types'

export class Catalog {
  tools = $state<ToolInfo[]>([])
  commands = $state<CommandInfo[]>([])
  skills = $state<SkillInfo[]>([])
  providers = $state<ProviderModels[]>([])
  defaults = $state<{ provider: string; model: string } | null>(null)
  error = $state('')

  private loading: Promise<void> | null = null

  /** Idempotent, and safe to call from several components at once. */
  async load(): Promise<void> {
    if (this.loading === null) {
      this.loading = this.fetchAll()
    }
    return this.loading
  }

  /** Forces a re-read, for when an extension reload has changed what exists. */
  async reload(): Promise<void> {
    this.loading = this.fetchAll()
    return this.loading
  }

  toolNamed(name: string): ToolInfo | undefined {
    return this.tools.find((tool) => tool.name === name)
  }

  modelsFor(provider: string): ProviderModels['models'] {
    return this.providers.find((entry) => entry.provider === provider)?.models ?? []
  }

  /** Command names as a completion would offer them, skills included. */
  completionNames(): string[] {
    return [
      ...this.commands.map((command) => command.name),
      ...this.skills.map((skill) => `skill:${skill.name}`)
    ]
  }

  private async fetchAll(): Promise<void> {
    try {
      const [tools, commands, skills, models] = await Promise.all([
        listTools(),
        listCommands(),
        listSkills(),
        listModels()
      ])

      this.tools = tools.tools
      this.commands = commands.commands
      this.skills = skills.skills
      this.providers = models.providers
      this.defaults = models.default
      this.error = ''
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
      // Let the next caller try again rather than caching the failure.
      this.loading = null
    }
  }
}

export const catalog = new Catalog()
