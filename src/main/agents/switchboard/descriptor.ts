// A harness descriptor over switchboard.
//
// Every harness grove offers is one of switchboard's run a particular way:
// Claude Code, Codex and pi as they come, or grove's own mode on top of one of
// them. What they share — probing, listing models and commands, starting a run —
// lives here; each passes in only what makes it different.

import type { HarnessId, HarnessInfo as SwitchboardInfo, ModelInfo } from '@neoworks/harness'
import type { CommandInfo, HarnessCapabilities, ModelEntry } from '../../../shared/agents'
import {
  toolInfoOf,
  type GroveTool,
  type HarnessDescriptor,
  type HarnessOffering,
  type HarnessRunOptions
} from '../harness'
import type { SwitchboardHost } from './host'
import { SwitchboardRun, type RunProfile } from './run'

export interface SwitchboardHarnessSpec {
  id: string
  label: string
  description: string
  icon: string
  capabilities: HarnessCapabilities
  /** The switchboard harnesses this one can run on; the model's provider picks one. */
  runsOn: HarnessId[]
  /** How a run is configured, for the harness it runs on. */
  profile(harness: HarnessId): Omit<RunProfile, 'harness'>
  /** The models a harness offers, when grove knows more than switchboard lists. */
  models?(harness: HarnessId, listed: ModelInfo[]): Promise<ModelEntry[]>
  /** Tools a session of this kind is served beside grove's own, made fresh for each session. */
  tools?(): GroveTool[]
}

/** A descriptor that probes, lists and starts through switchboard. */
export function switchboardHarness(
  host: SwitchboardHost,
  spec: SwitchboardHarnessSpec
): HarnessDescriptor {
  let offering: Promise<HarnessOffering> | null = null

  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    icon: spec.icon,
    capabilities: spec.capabilities,

    async probe() {
      const detected = await detect(host, spec.runsOn)
      const available = detected.filter((harness) => harness.available)
      if (available.length > 0) return { available: true, detail: null }
      const details = detected.map((harness) => harness.detail).filter(Boolean)
      return { available: false, detail: details.join('; ') || 'not installed' }
    },

    offering() {
      if (!offering) {
        offering = loadOffering(host, spec).catch((cause: Error) => {
          offering = null
          throw cause
        })
      }
      return offering
    },

    async start(options: HarnessRunOptions) {
      const harness = runtimeFor(spec.runsOn, options.provider)
      const profile: RunProfile = { harness, ...spec.profile(harness) }
      if (spec.tools) {
        const tools = spec.tools()
        profile.tools = () => tools
      }
      const run = new SwitchboardRun(host, profile, options)
      await run.start()
      return run
    }
  }
}

/**
 * The switchboard harness a session runs on. A descriptor that runs on several
 * names them as the providers of its models, so the model picker's provider is
 * the choice; one that runs on a single harness always uses it.
 */
function runtimeFor(runsOn: HarnessId[], provider: string | null): HarnessId {
  if (runsOn.length === 1) return runsOn[0]
  const named = runsOn.find((harness) => harness === provider)
  if (named) return named
  return runsOn[0]
}

async function detect(host: SwitchboardHost, runsOn: HarnessId[]): Promise<SwitchboardInfo[]> {
  const switchboard = await host.switchboard()
  const all = await switchboard.listHarnesses()
  return all.filter((harness) => runsOn.includes(harness.id))
}

/** Models and commands of every harness the descriptor runs on that is available. */
async function loadOffering(
  host: SwitchboardHost,
  spec: SwitchboardHarnessSpec
): Promise<HarnessOffering> {
  const available = (await detect(host, spec.runsOn)).filter((harness) => harness.available)
  const models: ModelEntry[] = []
  const commands: CommandInfo[] = []
  for (const harness of available) {
    models.push(...(await modelsOn(host, spec, harness.id)))
    commands.push(...(await commandsOn(host, harness.id)))
  }
  let tools: GroveTool[] = []
  if (spec.tools) tools = spec.tools()
  return { tools: tools.map(toolInfoOf), commands, skills: [], models, default: defaultOf(models) }
}

async function modelsOn(
  host: SwitchboardHost,
  spec: SwitchboardHarnessSpec,
  harness: HarnessId
): Promise<ModelEntry[]> {
  const switchboard = await host.switchboard()
  const listed = await switchboard.listModels(harness).catch((): ModelInfo[] => [])
  if (spec.models) return spec.models(harness, listed)
  return listed.map((model) => modelEntryOf(model, providerFor(spec, harness, model.id)))
}

/**
 * The provider a model is offered under. A descriptor spanning harnesses names
 * the harness, so picking the provider picks what runs it; otherwise the
 * harness's own `provider/model` prefix, when it uses one, keeps the cascade.
 */
function providerFor(spec: SwitchboardHarnessSpec, harness: HarnessId, modelId: string): string {
  if (spec.runsOn.length > 1) return harness
  const slash = modelId.indexOf('/')
  if (slash > 0) return modelId.slice(0, slash)
  return harness
}

/** The commands a harness offers, from switchboard versions that list them. */
async function commandsOn(host: SwitchboardHost, harness: HarnessId): Promise<CommandInfo[]> {
  const switchboard = (await host.switchboard()) as unknown as {
    listCommands?(harness: HarnessId): Promise<CommandInfo[]>
  }
  if (!switchboard.listCommands) return []
  return switchboard.listCommands(harness).catch(() => [])
}

export function modelEntryOf(model: ModelInfo, provider: string): ModelEntry {
  const entry: ModelEntry = {
    key: `${provider}:${model.id}`,
    label: model.name || model.id,
    routes: [{ provider, id: model.id, native: true }]
  }
  if (model.description) entry.description = model.description
  return entry
}

function defaultOf(models: ModelEntry[]): { provider: string; model: string } | null {
  const first = models[0]?.routes[0]
  if (!first) return null
  return { provider: first.provider, model: first.id }
}
