// What the kernel hands the app once it is up, and how components under `Root.svelte` reach
// it. This is not the plugin `Context`: components never receive that. They get the slots
// to render and a way to report an error, and everything else goes through plugins.

import { getContext, setContext } from "svelte";
import type { Context } from "@neoworks/extension-system";
import type { CommandsService } from "./commands";
import type { ExtensionsService } from "./extensions";
import type { KeymapService } from "./keymap";
import type { LoaderService, ProfileService } from "./profile";
import type { SettingsService } from "./settings";
import type { SlotsService } from "./slots";

export interface Kernel {
  /** The root plugin context. Only boot code and tests use it directly. */
  context: Context;
  slots: SlotsService;
  commands: CommandsService;
  keymap: KeymapService;
  loader: LoaderService;
  profile: ProfileService;
  settings: SettingsService;
  extensions: ExtensionsService;
  /** Resolves once every plugin in the profile has settled as active, waiting or failed. */
  loaded: Promise<void>;
  /** Writes an error that no plugin caught, such as a throwing slot entry, to the log. */
  reportError(source: string, error: unknown): void;
}

const KERNEL_CONTEXT = Symbol("grove.kernel");

/** Makes the kernel reachable from every component below the caller. */
export function provideKernel(kernel: Kernel): void {
  setContext(KERNEL_CONTEXT, kernel);
}

/** The kernel, for a component rendered under `Root.svelte`. */
export function useKernel(): Kernel {
  const kernel = getContext<Kernel | undefined>(KERNEL_CONTEXT);
  if (!kernel) {
    throw new Error("useKernel() was called outside the kernel's root component");
  }
  return kernel;
}
