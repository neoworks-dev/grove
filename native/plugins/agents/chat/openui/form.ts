// What a field's value is and how a change travels to the daemon (docs/neoui.md, "What the user
// does"). Plain functions and a small queue, tested without a window.
import type { Choice, GroupItem } from "./props";

/** How long typed text waits for the next key before it is sent. */
export const DEBOUNCE_MS = 150;

/** How long a value chosen here is held for the daemon to echo it. */
export const HOLD_MS = 2000;

/** The text a field shows for a value: a string or a number, else nothing. */
export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** Equal as the daemon sees them: 10 and 10.0 are one slider position, lists and objects by content. */
export function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether the text is a calendar date, `YYYY-MM-DD`. */
export function isDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return day >= 1 && day <= daysIn(year, month);
}

export function daysIn(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (month === 2) return leap ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** `YYYY-MM-DD` of a year, month (1 to 12) and day. */
export function dateText(year: number, month: number, day: number): string {
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** The parts of a date, or nothing when the text is not one. */
export function dateParts(text: string): { year: number; month: number; day: number } | undefined {
  if (!isDate(text)) return undefined;
  return {
    year: Number(text.slice(0, 4)),
    month: Number(text.slice(5, 7)),
    day: Number(text.slice(8)),
  };
}

/** The weekday of a date, 0 for Monday to 6 for Sunday. */
export function weekday(year: number, month: number, day: number): number {
  const sunday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (sunday + 6) % 7;
}

/** What a typed value is sent as: a date only when it is one (or empty), else not at all. */
export function sendable(kind: "text" | "date", text: string): boolean {
  return kind === "text" || text === "" || isDate(text);
}

/** A slider position snapped to its step, from `min`, and held to `min..max`. */
export function snap(value: number, min: number, max: number, step: number): number {
  const size = step > 0 ? step : 1;
  const snapped = Math.round((value - min) / size) * size + min;
  const held = Math.min(max, Math.max(min, snapped));
  // 0.1 + 0.2 and its kind: drop the float noise a step of 0.1 leaves.
  return Number(held.toFixed(10));
}

/** The position of a pointer along a track as a slider value. */
export function sliderAt(x: number, track: number, min: number, max: number, step: number): number {
  if (track <= 0) return min;
  const share = Math.min(1, Math.max(0, x / track));
  return snap(min + share * (max - min), min, max, step);
}

/** How far along its range a slider value is, 0 to 1. */
export function share(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** The option `by` places from the current one, held at the ends; none chosen: the first or last. */
export function pick(options: readonly Choice[], current: string, by: number): string | undefined {
  if (options.length === 0) return undefined;
  const at = options.findIndex((option) => option.value === current);
  if (at < 0) return (by < 0 ? options.at(-1) : options[0])?.value;
  const to = Math.min(options.length - 1, Math.max(0, at + by));
  return options[to]?.value;
}

/** Whether an item is on in a group's value: a list of names, or an object of name to flag. */
export function groupHas(value: unknown, name: string): boolean {
  if (Array.isArray(value)) return value.includes(name);
  if (typeof value === "object" && value !== null) {
    return (value as Record<string, unknown>)[name] === true;
  }
  return false;
}

/**
 * A group's value with one item flipped: a list of the checked names in the items' order for a
 * CheckBoxGroup, an object of every item's flag for a SwitchGroup.
 */
export function flip(
  value: unknown,
  items: readonly GroupItem[],
  name: string,
  asObject: boolean,
): unknown {
  const on = (item: GroupItem): boolean => groupHas(value, item.name) !== (item.name === name);
  if (asObject) return Object.fromEntries(items.map((item) => [item.name, on(item)]));
  return items.filter(on).map((item) => item.name);
}

/** `openui.input` arguments. */
export interface InputArgs {
  doc: string;
  key: string;
  value: unknown;
}

export type Send = (ref: string, action: string, args: unknown) => void;

interface Pending {
  ref: string;
  args: InputArgs;
  send: Send;
  timer: Parameters<typeof clearTimeout>[0];
}

/**
 * The values on their way to the daemon. Typing waits for a pause (the latest value of a field
 * replaces an earlier one that has not gone out), everything else goes at once; a press sends what
 * is still waiting first, so the daemon has the form's values when it runs the button.
 */
export class Outbox {
  private pending = new Map<string, Pending>();

  /** Sends `args.value` after `delay` ms (at once for 0). */
  queue(ref: string, args: InputArgs, delay: number, send: Send): void {
    const id = idOf(ref, args.doc, args.key);
    this.drop(id);
    if (delay <= 0) {
      send(ref, "openui.input", args);
      return;
    }
    const entry: Pending = { ref, args, send, timer: undefined };
    entry.timer = setTimeout(() => {
      this.pending.delete(id);
      send(ref, "openui.input", args);
    }, delay);
    this.pending.set(id, entry);
  }

  /** Sends what is waiting for a doc, or for one field of it. */
  flush(ref: string, doc: string, key?: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.ref !== ref || entry.args.doc !== doc) continue;
      if (key !== undefined && entry.args.key !== key) continue;
      this.drop(id);
      entry.send(ref, "openui.input", entry.args);
    }
  }

  /** Presses a button: what waits goes first. */
  press(ref: string, doc: string, key: string, send: Send): void {
    this.flush(ref, doc);
    send(ref, "openui.press", { doc, key });
  }

  /** Whether anything waits. */
  get waiting(): boolean {
    return this.pending.size > 0;
  }

  private drop(id: string): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
  }
}

function idOf(ref: string, doc: string, key: string): string {
  return JSON.stringify([ref, doc, key]);
}

/** The queue every doc in the window sends through: it outlives the rows that draw the docs. */
export const outbox = new Outbox();
