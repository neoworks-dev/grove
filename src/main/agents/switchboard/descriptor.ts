// A harness descriptor over switchboard.
//
// Every harness grove offers is one of switchboard's: Claude Code, Codex and pi,
// each either as it comes or in grove mode. What they share — probing, listing
// models and commands, starting a run, switching to grove mode — lives here;
// each passes in only what makes it different.

import type { HarnessId, HarnessInfo as SwitchboardInfo, ModelInfo } from '@neoworks/harness'
import type { CommandInfo, HarnessCapabilities, ModelEntry } from '../../../shared/agents'
import {
  toolInfoOf,
  type GroveTool,
  type HarnessDescriptor,
  type HarnessOffering,
  type HarnessRunOptions
} from '../harness'
import { groveModeOptions } from './groveMode'
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
  /**
   * The workspace tools a grove mode session is served in place of the
   * harness's own, made fresh for each session. A harness without them has no
   * grove mode.
   */
  groveModeTools?(): GroveTool[]
}

/** A descriptor that probes, lists and starts through switchboard. */
export function switchboardHarness(
  host: SwitchboardHost,
  spec: SwitchboardHarnessSpec
): HarnessDescriptor {
  let offering: Promise<HarnessOffering> | null = null
  let capabilities = spec.capabilities

  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    icon: spec.icon,
    // What the spec claims until switchboard has said what the harnesses can do.
    get capabilities() {
      return capabilities
    },

    async probe() {
      const detected = await detect(host, spec.runsOn)
      const available = detected.filter((harness) => harness.available)
      if (available.length > 0) capabilities = capabilitiesOf(spec.capabilities, available)
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
      let profile: RunProfile = { harness, ...spec.profile(harness) }
      if (options.groveMode && spec.groveModeTools) {
        profile = inGroveMode(profile, spec.groveModeTools())
      }
      const run = new SwitchboardRun(host, profile, options)
      await run.start()
      return run
    }
  }
}

/**
 * A profile switched to grove mode: grove's prompt and workspace tools in
 * place of the harness's, and everything else it brings turned off. The
 * harness itself and how it reaches its model stay as they are.
 */
function inGroveMode(profile: RunProfile, tools: GroveTool[]): RunProfile {
  return {
    ...profile,
    sessionOptions: (options) => groveModeOptions(options, tools),
    tools: () => tools
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
  // Listed whether or not a session uses them, so a grove mode transcript
  // shows its calls the way the tools describe them.
  let tools: GroveTool[] = []
  if (spec.groveModeTools) tools = spec.groveModeTools()
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

/** The commands and skills a harness offers under the user's own setup. */
async function commandsOn(host: SwitchboardHost, harness: HarnessId): Promise<CommandInfo[]> {
  const switchboard = await host.switchboard()
  return switchboard.listCommands(harness).catch((): CommandInfo[] => [])
}

/**
 * What grove can offer on the harnesses a descriptor runs on: a feature only
 * when every one of them has it, since the model picked decides which runs.
 * grove answers approvals and hosts its tools itself, so those stay as claimed.
 */
function capabilitiesOf(claimed: HarnessCapabilities, harnesses: SwitchboardInfo[]): HarnessCapabilities {
  const all = (has: (capabilities: SwitchboardInfo['capabilities']) => boolean): boolean =>
    harnesses.every((harness) => has(harness.capabilities))
  return {
    ...claimed,
    liveModelSwitch: all((capabilities) => capabilities.liveModel),
    thinking: all((capabilities) => capabilities.effort !== 'none'),
    steering: all((capabilities) => capabilities.steering),
    attachments: all((capabilities) => capabilities.images)
  }
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
