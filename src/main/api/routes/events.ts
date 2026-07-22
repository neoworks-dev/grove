// events.subscribe: a streaming route that pumps EventHub events until the
// caller cancels or its transport disconnects. Scope-gated per topic prefix
// before the subscription starts.

import type { EventHub, ApiEvent } from '../events'
import type { RouteRegistry } from '../registry'

interface EventDeps {
  hub: EventHub
}

export function registerEventRoutes(registry: RouteRegistry, deps: EventDeps): void {
  registry.register({
    method: 'events.subscribe',
    scope: null,
    streaming: true,
    handler: async (args, context) => {
      const topics = Array.isArray(args.topics) ? args.topics.map(String) : []
      for (const scope of deps.hub.scopesFor(topics)) {
        await context.broker.ensure(
          context.client,
          scope,
          `subscribe to events: ${topics.join(', ')}`
        )
      }
      return new Promise<null>((resolve) => {
        const unsubscribe = deps.hub.subscribe(topics, (event: ApiEvent) => {
          context.emit([event])
        })
        context.signal.addEventListener('abort', () => {
          unsubscribe()
          resolve(null)
        })
      })
    }
  })
}
