// The `keymap` service: key bindings that run commands by id, with multi-key sequences. It owns
// the window's key pipeline too, so overlays and dialogs can claim keys ahead of the bindings.
// The sequence engine is Grove's, without panes and modes, which the shell adds back as
// contexts when it has panes. Plain class with a ChangeSignal, like the other services.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../reactive";
import type { CommandsService } from "../commands";
import { resolveDefaultBindings, type OverrideMap } from "./bindingResolution";
import { KeyDispatcher, KeyPriority, type KeyEventInput, type KeyHandler } from "./keyDispatch";
import {
  findConflicts,
  firesWhileTyping,
  isModifierKey,
  sequenceStartsWith,
  stepFromEvent,
  stepLabel,
  type KeyStep,
  type ParsedSequence,
} from "./keySequence";

declare module "@neoworks/extension-system" {
  interface Context {
    keymap: KeymapService;
  }
}

export interface KeyBinding {
  id: string;
  /** A key sequence in the canonical grammar: `ctrl+s`, `ctrl+k ctrl+s`, `leader w h`. */
  keys: string;
  /** The id of the command to run. */
  command: string;
  /** Passed to the command after the key press. */
  args?: unknown[];
  group?: string;
  description?: string;
  /** Whether the binding applies now; a binding that does not is invisible to key presses. */
  when?: () => boolean;
}

/** A binding after overrides, with its keys parsed. */
export interface ResolvedBinding extends KeyBinding {
  sequence: ParsedSequence;
}

/** A key that can follow the keys typed so far, for a which-key hint. */
export interface NextKey {
  /** The keycap of the next step. */
  key: string;
  /** What it runs when it ends a sequence; undefined when more keys follow. */
  description?: string;
  /** Whether more keys follow it. */
  continues: boolean;
}

export class KeymapService extends Service {
  static inject = ["commands"];

  private commands: CommandsService;
  private dispatcher = new KeyDispatcher();
  private registered: KeyBinding[] = [];
  private overrideLayers: OverrideMap[] = [];
  private bareKeyGuards: (() => boolean)[] = [];
  private effectiveCache: ResolvedBinding[] | null = null;
  private pendingState: { active: boolean; leader: boolean; steps: KeyStep[] } = {
    active: false,
    leader: false,
    steps: [],
  };
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context) {
    super(ctx, "keymap");
    this.commands = ctx.commands;
    this.dispatcher.subscribe(KeyPriority.bindings, (event) => this.handleKey(event));
  }

  /**
   * Adds bindings. Keys that do not parse are skipped with a warning, and bindings that clash
   * with another are kept and warned about. They leave with the calling plugin, or when the
   * returned function is called.
   */
  bind(bindings: KeyBinding | KeyBinding[]): () => void {
    const list = Array.isArray(bindings) ? bindings : [bindings];
    return this.ctx.effect(() => {
      this.registered = [...this.registered, ...list];
      this.invalidate();
      this.warnAboutProblems(list);
      return () => {
        this.registered = this.registered.filter((binding) => !list.includes(binding));
        this.invalidate();
      };
    }, `keymap.bind(${list.map((binding) => binding.id).join(", ")})`);
  }

  /**
   * Rebinds by id: a string replaces a binding's keys and null unbinds it. Later layers beat
   * earlier ones. The layer leaves with the calling plugin, or when the returned function is called.
   */
  rebind(overrides: OverrideMap): () => void {
    return this.ctx.effect(() => {
      this.overrideLayers = [...this.overrideLayers, overrides];
      this.invalidate();
      return () => {
        this.overrideLayers = this.overrideLayers.filter((layer) => layer !== overrides);
        this.invalidate();
      };
    }, "keymap.rebind()");
  }

  /**
   * Subscribes to the window's keys ahead of the bindings, at one of the `KeyPriority` tiers. The
   * first handler to return true ends the chain. Leaves with the calling plugin.
   */
  subscribe(priority: number, handler: KeyHandler): () => void {
    return this.ctx.effect(() => this.dispatcher.subscribe(priority, handler), `keymap.subscribe(${priority})`);
  }

  /**
   * Lets bare keys, which a field or an editor would type, and the leader start bindings while the
   * predicate says so. Without a guard only chords and function keys fire. Leaves with the plugin.
   */
  allowBareKeys(predicate: () => boolean): () => void {
    return this.ctx.effect(() => {
      this.bareKeyGuards = [...this.bareKeyGuards, predicate];
      return () => {
        this.bareKeyGuards = this.bareKeyGuards.filter((guard) => guard !== predicate);
      };
    }, "keymap.allowBareKeys()");
  }

  /** Runs a window key through the subscribers and the bindings; true when one claimed it. */
  dispatch(event: KeyEventInput): boolean {
    return this.dispatcher.dispatch(event);
  }

  /** The bindings in force: registered ones with overrides applied. Reactive. */
  effective(): ResolvedBinding[] {
    this.changes.track();
    return this.resolvedBindings();
  }

  /** Whether some binding starts with the leader key, which is space. Reactive. */
  hasLeaderBindings(): boolean {
    return this.effective().some((binding) => binding.sequence.leader);
  }

  /** The keys a command answers to, as keycap labels, one per step; empty when it has none. Reactive. */
  keysFor(commandId: string): string[] {
    const binding = this.effective().find((candidate) => candidate.command === commandId);
    if (!binding) {
      return [];
    }
    const labels = binding.sequence.steps.map(stepLabel);
    if (binding.sequence.leader) {
      return ["␣", ...labels];
    }
    return labels;
  }

  /** Whether a sequence is begun and not finished, including a leader sequence that has no steps yet. Reactive. */
  isPending(): boolean {
    this.changes.track();
    return this.pendingState.active;
  }

  /** The steps of a sequence begun and not finished, for a which-key hint. Reactive. */
  pendingSteps(): KeyStep[] {
    this.changes.track();
    return this.pendingState.steps;
  }

  /**
   * The keys that can come next while a sequence is half typed, one per distinct key, in the order
   * their bindings were registered; empty when no sequence is pending. Reactive.
   */
  nextKeys(): NextKey[] {
    this.changes.track();
    if (!this.pendingState.active) {
      return [];
    }
    const prefix = this.pendingState.steps;
    const byKey = new Map<string, NextKey>();
    for (const binding of this.matching(prefix, this.pendingState.leader)) {
      const step = binding.sequence.steps[prefix.length];
      if (step === undefined) {
        continue;
      }
      const key = stepLabel(step);
      const continues = binding.sequence.steps.length > prefix.length + 1;
      const known = byKey.get(key);
      if (known === undefined) {
        byKey.set(key, { key, description: continues ? undefined : binding.description, continues });
      } else if (continues) {
        known.continues = true;
      }
    }
    return [...byKey.values()];
  }

  /** Drops a half-typed sequence. */
  cancelPending(): void {
    this.pendingState = { active: false, leader: false, steps: [] };
    this.changes.notify();
  }

  /** Forgets the derived binding list and tells readers it changed. */
  private invalidate(): void {
    this.effectiveCache = null;
    this.changes.notify();
  }

  /** The effective bindings, derived once per change. */
  private resolvedBindings(): ResolvedBinding[] {
    if (this.effectiveCache) {
      return this.effectiveCache;
    }
    const overrides: OverrideMap = Object.assign({}, ...this.overrideLayers);
    const resolved = resolveDefaultBindings(this.registered, overrides, (id, keys) => {
      this.ctx.logger.warn(`keymap: ignoring invalid key sequence "${keys}" for "${id}"`);
    });
    const byId = new Map(this.registered.map((binding) => [binding.id, binding]));
    const active: ResolvedBinding[] = [];
    for (const entry of resolved) {
      const base = byId.get(entry.id);
      if (!entry.unbound && base) {
        active.push({ ...base, keys: entry.keys, sequence: entry.sequence });
      }
    }
    this.effectiveCache = active;
    return active;
  }

  /** Logs sequences that do not parse and pairs of bindings that shadow one another. */
  private warnAboutProblems(added: KeyBinding[]): void {
    const addedIds = new Set(added.map((binding) => binding.id));
    const entries = this.resolvedBindings().map((binding) => ({
      id: binding.id,
      sequence: binding.sequence,
      guarded: binding.when !== undefined,
    }));
    const conflicts = findConflicts(entries);
    for (const conflict of conflicts) {
      if (addedIds.has(conflict.firstId) || addedIds.has(conflict.secondId)) {
        this.ctx.logger.warn(`keymap: "${conflict.firstId}" and "${conflict.secondId}" ${conflict.kind}`);
      }
    }
  }

  /** Whether bare keys may start a binding now, because some plugin vouched that nothing is typing. */
  private bareKeysAllowed(): boolean {
    return this.bareKeyGuards.some((guard) => guard());
  }

  /** The bindings whose keys start with the typed steps and that apply now. */
  private matching(prefix: KeyStep[], leader: boolean): ResolvedBinding[] {
    return this.resolvedBindings().filter((binding) => {
      if (binding.sequence.leader !== leader) {
        return false;
      }
      if (binding.when && !binding.when()) {
        return false;
      }
      if (!this.commands.canRun(binding.command)) {
        return false;
      }
      return sequenceStartsWith(binding.sequence.steps, prefix);
    });
  }

  /**
   * The binding among the matches whose keys are exactly `length` steps long, if any. A binding
   * with a `when` is for a context and so beats one without, which is for everywhere.
   */
  private exactMatch(matches: ResolvedBinding[], length: number): ResolvedBinding | undefined {
    const exact = matches.filter((binding) => binding.sequence.steps.length === length);
    const inContext = exact.find((binding) => binding.when !== undefined);
    if (inContext !== undefined) {
      return inContext;
    }
    return exact[0];
  }

  /** Runs a binding's command and marks the key as taken. */
  private fire(binding: ResolvedBinding, event: KeyEventInput): true {
    event.preventDefault();
    event.stopPropagation();
    this.cancelPending();
    void this.commands.run(binding.command, ...(binding.args ?? []));
    return true;
  }

  /** Starts a sequence that more keys must finish. */
  private startPending(leader: boolean, steps: KeyStep[], event: KeyEventInput): true {
    event.preventDefault();
    event.stopPropagation();
    this.pendingState = { active: true, leader, steps };
    this.changes.notify();
    return true;
  }

  /** The `bindings` tier of the pipeline: advances or starts a sequence; true when it took the key. */
  private handleKey(event: KeyEventInput): boolean {
    // Lone modifier presses never advance or break a sequence.
    if (isModifierKey(event.key)) {
      return this.pendingState.active;
    }
    if (this.pendingState.active) {
      return this.handlePendingKey(event);
    }
    const step = stepFromEvent(event);
    if (step.key === "space" && !step.ctrl && !step.alt && !step.meta) {
      return this.handleLeaderKey(event);
    }
    // Chords and function keys fire anywhere since they never type text; bare keys only
    // when a plugin has said nothing is typing.
    if (!firesWhileTyping(step) && !this.bareKeysAllowed()) {
      return false;
    }
    const matches = this.matching([step], false);
    if (matches.length === 0) {
      return false;
    }
    const exact = this.exactMatch(matches, 1);
    if (exact) {
      return this.fire(exact, event);
    }
    return this.startPending(false, [step], event);
  }

  /** Unmodified space begins a leader sequence when bare keys are allowed and some binding has one. */
  private handleLeaderKey(event: KeyEventInput): boolean {
    if (!this.bareKeysAllowed()) {
      return false;
    }
    if (this.matching([], true).length === 0) {
      return false;
    }
    return this.startPending(true, [], event);
  }

  /** The next key of a sequence already begun: it finishes, extends, aborts or breaks it. */
  private handlePendingKey(event: KeyEventInput): boolean {
    if (event.key === "Backspace") {
      this.pendingState = { ...this.pendingState, steps: this.pendingState.steps.slice(0, -1) };
      this.changes.notify();
      return true;
    }
    const next = [...this.pendingState.steps, stepFromEvent(event)];
    const matches = this.matching(next, this.pendingState.leader);
    const exact = this.exactMatch(matches, next.length);
    if (exact) {
      return this.fire(exact, event);
    }
    // Escape aborts the sequence, but only once nothing claims it, so a binding can end on one.
    if (event.key === "Escape") {
      return this.abortPending(event);
    }
    if (matches.length > 0) {
      return this.startPending(this.pendingState.leader, next, event);
    }
    // Dead end: swallow the key and drop out of the sequence.
    return this.abortPending(event);
  }

  /** Ends a sequence without running anything, taking the key that ended it. */
  private abortPending(event: KeyEventInput): true {
    event.preventDefault();
    event.stopPropagation();
    this.cancelPending();
    return true;
  }
}
