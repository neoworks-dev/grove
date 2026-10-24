// Boots the kernel: the root context, its services, and the profile's plugins. The window
// is already up while this runs, and everything it draws arrives through slots as plugins
// activate, so a plugin that is slow or broken never holds the window back.

import { Context } from "@neoworks/extension-system";
import { CommandsService } from "./commands";
import { ExtensionsService, type ExtensionFiles, type SharedModules } from "./extensions";
import type { Kernel } from "./kernel";
import { KeymapService } from "./keymap";
import { mountHostLogExporter } from "./logging";
import { LoaderService, ProfileService, type PluginCatalog, type ProfileFiles, type ProfileRow } from "./profile";
import { SettingsService } from "./settings";
import { SlotsService } from "./slots";

export interface BootOptions {
  /** The core plugins this bundle contains, by the name profile rows give them. */
  catalog: PluginCatalog;
  /** The core layer of the profile. */
  coreRows: ProfileRow[];
  files: ProfileFiles;
  /**
   * Where installed extensions are read from and what their scripts may `require`. Without it
   * the app runs the core plugins only, as under test.
   */
  extensions?: { files: ExtensionFiles; modules: SharedModules };
}

/**
 * Creates the root context, mounts the services and starts reading the profile and loading its
 * plugins. Resolves with the kernel once the services are up; `kernel.loaded` follows when
 * the plugins have settled.
 */
export async function bootKernel(options: BootOptions): Promise<Kernel> {
  const context = new Context();
  mountHostLogExporter(context);
  await context.plugin(CommandsService);
  await context.plugin(KeymapService);
  await context.plugin(SlotsService);
  // Extension plugins are added to this copy, so the bundle's own catalog is never changed.
  const catalog: PluginCatalog = { ...options.catalog };
  let extensionFiles: ExtensionFiles | null = null;
  let extensionModules: SharedModules = {};
  if (options.extensions) {
    extensionFiles = options.extensions.files;
    extensionModules = options.extensions.modules;
  }
  await context.plugin(ExtensionsService, { catalog, files: extensionFiles, modules: extensionModules });
  await context.plugin(LoaderService, catalog);
  await context.plugin(SettingsService, { catalog, files: options.files });
  await context.plugin(ProfileService, { coreRows: options.coreRows, files: options.files });

  // No folder is open yet, so this is the core and user layers. Opening a folder adds the
  // project layer through `ctx.profile.setProjectFolder`.
  const loaded = context.profile.reload();
  return {
    context,
    slots: context.slots,
    commands: context.commands,
    keymap: context.keymap,
    loader: context.loader,
    profile: context.profile,
    settings: context.settings,
    extensions: context.extensions,
    loaded,
    reportError(source, error) {
      context.logger(source).error(error);
    },
  };
}
