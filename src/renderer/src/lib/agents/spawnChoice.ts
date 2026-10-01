// What a spawn's approval lets the user change: the runtime, model and effort
// the new agent starts on. A change goes back as the call's edited input, so
// the agent runs on what was approved, and the transcript says so.

import type { SpawnTarget, ThinkingLevel } from './types'

/** What a spawn will run on, as the user left it in its approval. */
export interface SpawnChoice {
  harness: string | null
  provider: string | null
  model: string | null
  /** The model is the runtime's own default, so the call does not name one. */
  modelIsDefault: boolean
  effort: ThinkingLevel | null
}

/** The choice an approval opens on: what the call asked for, resolved. */
export function choiceOf(target: SpawnTarget): SpawnChoice {
  return {
    harness: target.harness,
    provider: target.provider,
    model: target.model,
    modelIsDefault: target.modelIsDefault,
    effort: target.effort
  }
}

/** Whether the user changed anything the call would run on. */
export function choiceChanged(target: SpawnTarget, choice: SpawnChoice): boolean {
  if (choice.harness !== target.harness) return true
  if (choice.model !== target.model) return true
  if (choice.provider !== target.provider) return true
  if (choice.modelIsDefault !== target.modelIsDefault) return true
  return choice.effort !== target.effort
}

/**
 * The input a spawn runs with once approved, or undefined when the user changed
 * nothing and the call runs as the agent made it. A default model stays
 * unnamed, so the runtime picks it when the agent starts.
 */
export function spawnInputFor(
  input: unknown,
  target: SpawnTarget,
  choice: SpawnChoice
): Record<string, unknown> | undefined {
  if (!choiceChanged(target, choice)) return undefined
  const edited: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  delete edited.harness
  delete edited.model
  delete edited.provider
  delete edited.effort
  if (choice.harness) edited.harness = choice.harness
  if (choice.model && !choice.modelIsDefault) {
    edited.model = choice.model
    if (choice.provider) edited.provider = choice.provider
  }
  if (choice.effort) edited.effort = choice.effort
  return edited
}
