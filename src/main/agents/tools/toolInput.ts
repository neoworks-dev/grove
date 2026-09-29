// Reading tool inputs, which arrive from the model unvalidated.

/** Tool inputs arrive unvalidated; an addressee that is not a string has none. */
export function stringOrNothing(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  return value
}

/** A limit a model wrote: a positive whole number, or the default. */
export function limitOf(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}

/** The answer to a call that named an agent nobody here is called. */
export function unknownAgent(reference: string): { content: string; isError: true } {
  return {
    content: `No agent here is called "${reference}". Call \`list_agents\` for the ids.`,
    isError: true
  }
}
