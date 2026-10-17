// The slot registry: which places the UI declares, and which entries plug into them. Plain
// TypeScript with no Svelte and no context, so the rules for kinds and priorities are
// testable on their own. The `slots` service wraps it with effects and a change signal.

import type { Component } from "svelte";

export type SlotKind = "single" | "list" | "keyed";

export interface SlotEntry {
  id: string;
  /** Position within a list slot, ascending; entries with the same order keep registration order. */
  order?: number;
  /** Shadowing rank, lowest wins. Defaults to `DEFAULT_PRIORITY`, so an override can sit just below it. */
  priority?: number;
  /** Which value of a keyed slot this entry answers to. */
  key?: string;
  // The component is any Svelte component; its props are whatever the entry passes.
  component: Component<any>;
  props?: Record<string, unknown>;
}

/** The priority of an entry that names none. */
export const DEFAULT_PRIORITY = 100;

interface Declaration {
  kind: SlotKind;
  owner: string;
  token: object;
}

interface Registration {
  entry: SlotEntry;
  owner: string;
  sequence: number;
}

/** What `declare` could not keep: an entry that waited for the declaration and then clashed. */
export interface RejectedEntry {
  slot: string;
  entry: SlotEntry;
  owner: string;
  reason: string;
}

/** One declared slot as `describe` reports it. */
export interface SlotDescription {
  name: string;
  kind: SlotKind;
  owner: string;
  entries: { id: string; owner: string }[];
}

export class SlotRegistry {
  private declarations = new Map<string, Declaration>();
  private registrations = new Map<string, Registration[]>();
  private nextSequence = 0;

  /**
   * Claims a slot name for the component that renders it. Throws when the name is taken.
   * Entries registered earlier were waiting for this; those that clash are dropped and returned.
   */
  declare(name: string, kind: SlotKind, owner: string): { token: object; rejected: RejectedEntry[] } {
    const existing = this.declarations.get(name);
    if (existing) {
      throw new Error(`slot "${name}" is already declared by ${existing.owner}`);
    }
    const token = {};
    this.declarations.set(name, { kind, owner, token });
    return { token, rejected: this.dropClashingWaiters(name, kind) };
  }

  /** Releases a declaration. Entries stay registered and wait for the slot to be declared again. */
  undeclare(name: string, token: object): void {
    const declaration = this.declarations.get(name);
    if (!declaration || declaration.token !== token) {
      return;
    }
    this.declarations.delete(name);
  }

  isDeclared(name: string): boolean {
    return this.declarations.has(name);
  }

  kindOf(name: string): SlotKind | undefined {
    return this.declarations.get(name)?.kind;
  }

  /**
   * Adds an entry. When the slot is declared, a clash with an occupant of the same cell and
   * priority throws, naming the occupant. When it is not, the entry waits for the declaration.
   * Returns the function that removes it.
   */
  register(name: string, entry: SlotEntry, owner: string): () => void {
    const kind = this.kindOf(name);
    if (kind) {
      this.assertFits(name, kind, entry);
    }
    const registration: Registration = { entry, owner, sequence: this.nextSequence };
    this.nextSequence += 1;
    this.registrations.set(name, [...this.registeredIn(name), registration]);
    return () => this.remove(name, registration);
  }

  /** The entries a slot renders now: nothing before it is declared, then its winners by kind. */
  resolve(name: string): SlotEntry[] {
    const kind = this.kindOf(name);
    if (!kind) {
      return [];
    }
    const winners = this.winners(this.registeredIn(name), kind);
    if (kind === "list") {
      winners.sort(byOrderThenSequence);
    }
    return winners.map((registration) => registration.entry);
  }

  /** Every slot with its kind, owner and the entries that win in it, for diagnostics. */
  describe(): SlotDescription[] {
    const described: SlotDescription[] = [];
    for (const [name, declaration] of this.declarations) {
      const winners = this.winners(this.registeredIn(name), declaration.kind);
      const entries = winners.map((winner) => ({ id: winner.entry.id, owner: winner.owner }));
      described.push({ name, kind: declaration.kind, owner: declaration.owner, entries });
    }
    return described;
  }

  /** Removes one registration, if it is still there. */
  private remove(name: string, registration: Registration): void {
    const list = this.registrations.get(name);
    if (!list) {
      return;
    }
    const remaining = list.filter((candidate) => candidate !== registration);
    if (remaining.length === 0) {
      this.registrations.delete(name);
      return;
    }
    this.registrations.set(name, remaining);
  }

  /** The entries registered under a slot name, whether or not the slot is declared yet. */
  private registeredIn(name: string): Registration[] {
    const registrations = this.registrations.get(name);
    if (!registrations) {
      return [];
    }
    return registrations;
  }

  /** Throws when the entry cannot take its place in a slot of this kind. */
  private assertFits(name: string, kind: SlotKind, entry: SlotEntry): void {
    const reason = misfit(name, kind, entry, this.registeredIn(name));
    if (reason) {
      throw new Error(reason);
    }
  }

  /** After a declaration, removes waiting entries that do not fit the kind, keeping the first of a clash. */
  private dropClashingWaiters(name: string, kind: SlotKind): RejectedEntry[] {
    const kept: Registration[] = [];
    const rejected: RejectedEntry[] = [];
    for (const registration of this.registeredIn(name)) {
      const reason = misfit(name, kind, registration.entry, kept);
      if (reason) {
        rejected.push({ slot: name, entry: registration.entry, owner: registration.owner, reason });
        continue;
      }
      kept.push(registration);
    }
    if (kept.length > 0) {
      this.registrations.set(name, kept);
    } else {
      this.registrations.delete(name);
    }
    return rejected;
  }

  /** The lowest-priority registration of each cell. */
  private winners(registrations: Registration[], kind: SlotKind): Registration[] {
    const bestByCell = new Map<string, Registration>();
    for (const registration of registrations) {
      const cell = cellOf(kind, registration.entry);
      const best = bestByCell.get(cell);
      if (!best || priorityOf(registration.entry) < priorityOf(best.entry)) {
        bestByCell.set(cell, registration);
      }
    }
    return [...bestByCell.values()].sort((first, second) => first.sequence - second.sequence);
  }
}

/**
 * Why an entry cannot join a slot that already holds `peers`, or null when it can: a keyed
 * entry needs a key, and two entries in one cell cannot share a priority.
 */
function misfit(name: string, kind: SlotKind, entry: SlotEntry, peers: Registration[]): string | null {
  if (kind === "keyed" && !entry.key) {
    return `entry "${entry.id}" needs a key for the keyed slot "${name}"`;
  }
  const cell = cellOf(kind, entry);
  const occupant = peers.find((peer) => {
    return cellOf(kind, peer.entry) === cell && priorityOf(peer.entry) === priorityOf(entry);
  });
  if (!occupant) {
    return null;
  }
  return `slot "${name}" already has "${occupant.entry.id}" from ${occupant.owner} at priority ${priorityOf(entry)}`;
}

/** The entry's priority with the default filled in. */
function priorityOf(entry: SlotEntry): number {
  if (entry.priority === undefined) {
    return DEFAULT_PRIORITY;
  }
  return entry.priority;
}

/**
 * The cell an entry competes in: the whole slot for a single, its id for a list, its key for a
 * keyed slot. Entries in different cells all render; entries in one cell shadow each other.
 */
function cellOf(kind: SlotKind, entry: SlotEntry): string {
  if (kind === "single") {
    return "";
  }
  if (kind === "list") {
    return entry.id;
  }
  if (entry.key === undefined) {
    return "";
  }
  return entry.key;
}

/** The entry's list position with the default filled in. */
function orderOf(entry: SlotEntry): number {
  if (entry.order === undefined) {
    return 0;
  }
  return entry.order;
}

function byOrderThenSequence(first: Registration, second: Registration): number {
  const firstOrder = orderOf(first.entry);
  const secondOrder = orderOf(second.entry);
  if (firstOrder !== secondOrder) {
    return firstOrder - secondOrder;
  }
  return first.sequence - second.sequence;
}
