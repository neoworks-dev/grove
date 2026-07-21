// EventHub: the shared publish/subscribe surface behind events.subscribe.
// Domain services publish; subscriptions are streaming route calls, so
// lifetime, cancellation, and disconnect cleanup ride the existing stream
// machinery on both transports. Topic prefixes map to permission scopes so
// delivery is gated exactly like the routes that produce the data.

import type { PluginPermission } from '../../shared/plugins'

export interface ApiEvent {
  topic: string
  payload: unknown
  worktreeId?: string
}

interface Subscriber {
  topics: string[]
  push: (event: ApiEvent) => void
}

interface TopicScope {
  prefix: string
  scope: PluginPermission
}

export class EventHub {
  private subscribers = new Set<Subscriber>()
  private topicScopes: TopicScope[] = []

  publish(event: ApiEvent): void {
    for (const subscriber of this.subscribers) {
      if (!matchesAny(subscriber.topics, event.topic)) continue
      subscriber.push(event)
    }
  }

  // Returns the unsubscribe function; topics are exact names or prefixes
  // ('git.' delivers every git.* event).
  subscribe(topics: string[], push: (event: ApiEvent) => void): () => void {
    const subscriber: Subscriber = { topics, push }
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  registerTopicScope(prefix: string, scope: PluginPermission): void {
    this.topicScopes.push({ prefix, scope })
  }

  // Every scope a client must hold to subscribe to the given topics. Topics
  // outside every registered prefix (files/theme/workspace) need none.
  scopesFor(topics: string[]): PluginPermission[] {
    const needed = new Set<PluginPermission>()
    for (const topic of topics) {
      for (const entry of this.topicScopes) {
        if (topic.startsWith(entry.prefix) || entry.prefix.startsWith(topic)) {
          needed.add(entry.scope)
        }
      }
    }
    return [...needed]
  }
}

function matchesAny(topics: string[], eventTopic: string): boolean {
  return topics.some((topic) => eventTopic === topic || eventTopic.startsWith(topic))
}
