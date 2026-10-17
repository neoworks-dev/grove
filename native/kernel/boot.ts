// Boots the kernel: the root context, its services, and the profile's plugins. The window
// is already up while this runs, and everything it draws arrives through slots as plugins
// activate, so a plugin that is slow or broken never holds the window back.

import { Context } from "@neoworks/extension-system";
import { CommandsService } from "./commands";
import type { Kernel } from "./kernel";
import { KeymapService } from "./keymap";
import { mountHostLogExporter } from "./logging";
import { LoaderService, loadProfile, type PluginCatalog, type ProfileFiles, type ProfileRow } from "./profile";
import { SlotsService } from "./slots";

export interface BootOptions {
  /** The core plugins this bundle contains, by the name profile rows give them. */
  catalog: PluginCatalog;
  /** The core layer of the profile. */
  coreRows: ProfileRow[];
  files: ProfileFiles;
}

/**
 * Creates the root context, mounts the services, reads the profile and starts loading its
 * plugins. Resolves with the kernel once the services are up; `kernel.loaded` follows when
 * the plugins have settled.
 */
export async function bootKernel(options: BootOptions): Promise<Kernel> {
  const context = new Context();
  mountHostLogExporter(context);
  await context.plugin(CommandsService);
  await context.plugin(KeymapService);
  await context.plugin(SlotsService);
  await context.plugin(LoaderService, options.catalog);

  const profile = await loadProfile(options.coreRows, options.files);
  for (const problem of profile.problems) {
    context.logger.warn(problem);
  }
  const loaded = context.loader.apply(profile.rows);
  return {
    context,
    slots: context.slots,
    keymap: context.keymap,
    loader: context.loader,
    loaded,
    reportError(source, error) {
      context.logger(source).error(error);
    },
  };
}
