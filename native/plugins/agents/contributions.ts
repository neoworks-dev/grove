// What plugins add to Grove's presence with the suite daemon: neoui components the agent may
// write, and the tools their buttons call. Both are plain data keyed by name, held in a small
// registry on the agents service, which sends the presence again whenever one changes.

import type { McpEndpoint } from "@suite/protocol/types";

/** A neoui component Grove offers the agent, as the daemon's `app.presence` wants it. */
export interface AppComponent {
  /** What it is and when to use it; the agent reads it. */
  description: string;
  /** Its attributes by name; each type is string, number, boolean or any, with `[]` and `?` after. */
  params: Record<string, string>;
  /** The body, neoui over the `suite@1` library, with the params in scope by name. */
  neoui: string;
}

/** A tool the daemon's gateway may call on Grove, which a component's button reaches with `hx-post`. */
export interface AppTool {
  /** The name without the app: the agent and the components write it as `grove.<name>`. */
  name: string;
  description: string;
  /** JSON Schema of the arguments, an object schema. */
  inputSchema: Record<string, unknown>;
  /** Runs the tool; the text it returns is the result, and a thrown error is a failed call. */
  run(args: Record<string, unknown>): Promise<string>;
}

/** The server that answers the gateway's tool calls, which the host provides. */
export interface ToolServer {
  /** Lists these tools (replacing the earlier ones) and resolves to the endpoint the presence carries. */
  serve(tools: readonly AppTool[]): Promise<McpEndpoint>;
}

/** Named entries that plugins add and take away again, with a signal when the set changes. */
export class NamedRegistry<Entry> {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly kind: string) {}

  /** Adds entries and returns the call that takes them away; a name that is taken is refused. */
  add(added: Record<string, Entry>): () => void {
    const names = Object.keys(added);
    for (const name of names) {
      if (this.entries.has(name)) {
        throw new Error(`the ${this.kind} ${name} is already registered`);
      }
    }
    for (const name of names) {
      this.entries.set(name, added[name]);
    }
    this.notify();
    return () => {
      for (const name of names) {
        this.entries.delete(name);
      }
      this.notify();
    };
  }

  /** Every entry, by name. */
  all(): Record<string, Entry> {
    return Object.fromEntries(this.entries);
  }

  /** The entries without their names. */
  values(): Entry[] {
    return [...this.entries.values()];
  }

  /** Calls the listener whenever the set changes; returns the call that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
