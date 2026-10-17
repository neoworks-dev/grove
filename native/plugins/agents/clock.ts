// One clock for the elapsed times and ages on screen, ticking only while something shows one.

import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";

const INTERVAL_MS = 1000;

class Clock {
  private current = Date.now();
  private users = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private changes: ChangeSignal = createChangeSignal();

  /** Unix milliseconds, as of the last tick. Reactive. */
  get now(): number {
    this.changes.track();
    return this.current;
  }

  /** Something that shows a time appeared; returns the call that says it went away. */
  join(): () => void {
    this.users += 1;
    this.current = Date.now();
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.tick(), INTERVAL_MS);
    }
    return () => this.leave();
  }

  /** Moves the clock on to the present. */
  private tick(): void {
    this.current = Date.now();
    this.changes.notify();
  }

  /** Something went away; the clock stops with the last. */
  private leave(): void {
    this.users -= 1;
    if (this.users === 0 && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export const clock = new Clock();
