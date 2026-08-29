// What the mounted harnesses offer: tools, commands, skills and models.
//
// None of it changes while a session runs, so each harness is fetched once and
// shared. Several parts of the UI want the same lists — the composer completes
// commands, the approval card needs a tool's schema, the picker needs models —
// and none should fetch its own.
//
// The catalog is keyed by harness because two sessions in the same window can be
// running different ones. `use()` names the harness the pane is showing, and the
// fields below answer for that one.

import { getCatalog, listHarnesses } from './api'
import type {
  CommandInfo,
  HarnessCatalog,
  HarnessInfo,
  ProviderModels,
  SkillInfo,
  ToolInfo
} from './types'

const EMPTY: Omit<HarnessCatalog, 'harness'> = {
  tools: [],
  commands: [],
  skills: [],
  providers: [],
  default: null
}

export class Catalog {
  /** Every harness grove has mounted, with whether it can actually run. */
  harnesses = $state<HarnessInfo[]>([])
  /** The harness the fields below describe. */
  active = $state<string | null>(null)
  byHarness = $state<Record<string, Omit<HarnessCatalog, 'harness'>>>({})
  error = $state('')

  private harnessLoad: Promise<void> | null = null
  private loads = new Map<string, Promise<void>>()

  get tools(): ToolInfo[] {
    return this.current().tools
  }

  get commands(): CommandInfo[] {
    return this.current().commands
  }

  get skills(): SkillInfo[] {
    return this.current().skills
  }

  get providers(): ProviderModels[] {
    return this.current().providers
  }

  get defaults(): { provider: string; model: string } | null {
    return this.current().default
  }

  /** The harnesses that can be started right now. */
  get available(): HarnessInfo[] {
    return this.harnesses.filter((harness) => harness.available)
  }

  harnessNamed(id: string | null): HarnessInfo | undefined {
    if (!id) return undefined
    return this.harnesses.find((harness) => harness.id === id)
  }

  /** Load the harness listing once. Safe to call from several components. */
  async load(): Promise<void> {
    if (this.harnessLoad === null) this.harnessLoad = this.fetchHarnesses()
    return this.harnessLoad
  }

  /** Point the catalog at a harness, fetching its offering the first time. */
  async use(harnessId: string | null): Promise<void> {
    this.active = harnessId
    if (!harnessId) return
    await this.load()
    await this.fetchCatalog(harnessId)
  }

  /** Force a re-read, for when a harness has been reloaded or logged in to. */
  async reload(): Promise<void> {
    this.harnessLoad = null
    this.loads.clear()
    this.byHarness = {}
    await this.load()
    if (this.active) await this.fetchCatalog(this.active)
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

  private current(): Omit<HarnessCatalog, 'harness'> {
    if (!this.active) return EMPTY
    return this.byHarness[this.active] ?? EMPTY
  }

  private async fetchHarnesses(): Promise<void> {
    try {
      this.harnesses = await listHarnesses()
      this.error = ''
    } catch (cause) {
      this.error = messageOf(cause)
      // Let the next caller try again rather than caching the failure.
      this.harnessLoad = null
    }
  }

  private fetchCatalog(harnessId: string): Promise<void> {
    const pending = this.loads.get(harnessId)
    if (pending !== undefined) return pending

    const load = getCatalog(harnessId)
      .then((catalog) => {
        this.byHarness = { ...this.byHarness, [harnessId]: catalog }
        this.error = ''
      })
      .catch((cause: unknown) => {
        this.error = messageOf(cause)
        this.loads.delete(harnessId)
      })
    this.loads.set(harnessId, load)
    return load
  }
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return JSON.stringify(cause)
}

export const catalog = new Catalog()
