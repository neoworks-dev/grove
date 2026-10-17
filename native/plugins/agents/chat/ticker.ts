// One clock for every spinner on screen, running only while one is mounted.

import { createChangeSignal, type ChangeSignal } from "../../../kernel/reactive";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 90;

class Ticker {
  private tick = 0;
  private users = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private changes: ChangeSignal = createChangeSignal();

  /** The spinner's current glyph. Reactive. */
  get frame(): string {
    this.changes.track();
    return FRAMES[this.tick % FRAMES.length];
  }

  /** A spinner appeared; returns the call that says it went away. */
  join(): () => void {
    this.users += 1;
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.advance(), INTERVAL_MS);
    }
    return () => this.leave();
  }

  /** Moves every spinner on to its next glyph. */
  private advance(): void {
    this.tick += 1;
    this.changes.notify();
  }

  /** A spinner went away; the clock stops with the last one. */
  private leave(): void {
    this.users -= 1;
    if (this.users === 0 && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export const ticker = new Ticker();
