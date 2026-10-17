// A bridge between plain TypeScript state and Svelte's reactivity. The kernel's services are
// plain classes so that `bun test` can run them without compiling Svelte, and so that a
// `$state` field never lands on a `Service` (see the grove-plugins skill). A service owns a
// ChangeSignal instead: its readers call `track()` and its writers call `notify()`.

import { createSubscriber } from "svelte/reactivity";

export interface ChangeSignal {
  /** Makes the running effect or template depend on this signal; does nothing outside one. */
  track(): void;
  /** Reruns everything that tracked the signal. */
  notify(): void;
}

/**
 * A signal for state that lives outside Svelte. Under `bun test` Svelte resolves its server
 * build, where `createSubscriber` does nothing, so the signal is inert there and the
 * services' plain logic is all the tests see.
 */
export function createChangeSignal(): ChangeSignal {
  let rerunReaders: (() => void) | undefined;
  const subscribe = createSubscriber((update) => {
    rerunReaders = update;
    return () => {
      rerunReaders = undefined;
    };
  });
  return {
    track: () => subscribe(),
    notify: () => {
      if (rerunReaders) {
        rerunReaders();
      }
    },
  };
}
