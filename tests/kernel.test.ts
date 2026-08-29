// Smoke test for the @neoworks/extension-system kernel Grove is migrating onto.
// Not a test of the kernel itself (it ships its own suite) — it proves the
// linked dependency resolves under bun and that the three guarantees the
// migration relies on hold: fibers wait for their injected services, effects
// revert on dispose, and nothing survives an unload.

import { describe, it, expect } from 'bun:test'
import { Context, Service, FiberState } from '@neoworks/extension-system'

/** Let pending fiber transitions settle — the kernel resolves them off a microtask. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

class Registry {
  entries: string[] = []

  /** Register an entry; returns the inverse, as every Grove registry does. */
  register(entry: string): () => void {
    this.entries.push(entry)
    return () => {
      this.entries = this.entries.filter((existing) => existing !== entry)
    }
  }
}

class PanesService extends Service {
  registry = new Registry()

  constructor(ctx: Context) {
    super(ctx, 'panes')
  }

  register(entry: string): () => void {
    return this.registry.register(entry)
  }
}

declare module '@neoworks/extension-system' {
  interface Context {
    panes: PanesService
  }
}

// A consumer that may only run while `panes` exists — the shape every Grove
// core plugin takes once the sidebar/editor/panel own their services.
const consumer = {
  name: 'consumer',
  inject: ['panes'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.panes.register('editor'), 'pane:editor')
  }
}

describe('extension-system kernel', () => {
  it('holds a fiber PENDING until its injected service is provided', async () => {
    const root = new Context()
    const fiber = root.plugin(consumer)
    await settle()
    expect(fiber.state).toBe(FiberState.PENDING)

    await root.plugin(PanesService)
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(root.panes.registry.entries).toEqual(['editor'])
  })

  it('reverts effects when the consumer is disposed', async () => {
    const root = new Context()
    await root.plugin(PanesService)
    const fiber = await root.plugin(consumer)
    expect(root.panes.registry.entries).toEqual(['editor'])

    await fiber.dispose()
    expect(root.panes.registry.entries).toEqual([])
  })

  it('deactivates dependents when the provider goes away, and reactivates them', async () => {
    const root = new Context()
    const provider = await root.plugin(PanesService)
    const fiber = await root.plugin(consumer)
    expect(fiber.state).toBe(FiberState.ACTIVE)

    await provider.dispose()
    await settle()
    expect(fiber.state).toBe(FiberState.PENDING)

    const revived = await root.plugin(PanesService)
    await settle()
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(revived.ctx.panes.registry.entries).toEqual(['editor'])
  })

  it('labels installed effects so the debug harness can inspect them', async () => {
    const root = new Context()
    await root.plugin(PanesService)
    const fiber = await root.plugin(consumer)
    const labels = fiber.ctx.fiber.getEffects().map((effect) => effect.label)
    expect(labels).toContain('pane:editor')
  })
})
