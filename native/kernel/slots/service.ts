// The `slots` service. A component that renders a place in the UI declares it by name, other
// plugins register entries into it, and `<Slot>` draws what wins. Every call is tracked on the
// calling plugin's fiber, so unloading a plugin takes its declarations and entries with it.
//
// The service is a plain class: its reactivity is a ChangeSignal rather than a `$state`
// field, which would break once `isolate` or `intercept` re-creates the service with
// `Object.create()` (see the grove-plugins skill).

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../reactive";
import { SlotRegistry, type RejectedEntry, type SlotDescription, type SlotEntry, type SlotKind } from "./registry";

declare module "@neoworks/extension-system" {
  interface Context {
    slots: SlotsService;
  }
}

/** The one slot the kernel declares itself: the app's root, drawn by `Root.svelte`. */
export const ROOT_SLOT = "root";

const KERNEL_OWNER = "kernel";

export class SlotsService extends Service {
  private registry = new SlotRegistry();
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context) {
    super(ctx, "slots");
    this.registry.declare(ROOT_SLOT, "single", KERNEL_OWNER);
  }

  /**
   * Declares a slot, for the plugin whose component renders it. Declaring a name twice throws.
   * The declaration ends with the calling plugin, or when the returned function is called.
   */
  declare(name: string, kind: SlotKind): () => void {
    const owner = this.ctx.fiber.name;
    return this.ctx.effect(() => {
      const { token, rejected } = this.registry.declare(name, kind, owner);
      this.reportRejected(rejected);
      this.changes.notify();
      return () => {
        this.registry.undeclare(name, token);
        this.changes.notify();
      };
    }, `slots.declare(${name})`);
  }

  /**
   * Registers an entry into a slot. It waits when the slot is not declared yet. In a declared
   * slot, an entry that shares a cell and a priority with another throws, naming that occupant.
   * The entry leaves with the calling plugin, or when the returned function is called.
   */
  register(name: string, entry: SlotEntry): () => void {
    const owner = this.ctx.fiber.name;
    return this.ctx.effect(() => {
      const remove = this.registry.register(name, entry, owner);
      this.changes.notify();
      return () => {
        remove();
        this.changes.notify();
      };
    }, `slots.register(${name}, ${entry.id})`);
  }

  /** The entries a slot renders now. Reactive: reading it in a template or `$effect` tracks changes. */
  entries(name: string): SlotEntry[] {
    this.changes.track();
    return this.registry.resolve(name);
  }

  /** Whether a plugin has declared the slot. Reactive. */
  isDeclared(name: string): boolean {
    this.changes.track();
    return this.registry.isDeclared(name);
  }

  /** Every declared slot and its occupants, for diagnostics. */
  describe(): SlotDescription[] {
    this.changes.track();
    return this.registry.describe();
  }

  /** Logs the entries a new declaration could not keep, since its declarer is not the one at fault. */
  private reportRejected(rejected: RejectedEntry[]): void {
    for (const entry of rejected) {
      this.ctx.logger.error(`${entry.owner} could not register into ${entry.slot}: ${entry.reason}`);
    }
  }
}
