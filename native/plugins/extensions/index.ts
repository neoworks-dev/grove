// The extensions plugin: a rail view that lists the installed extensions and searches npm for
// more, with the registry it searches as a setting. The kernel's `extensions` service does the
// installing; this plugin is the way to ask for it.

import type { Context } from "@neoworks/extension-system";
import puzzlePiece from "@phosphor-icons/core/regular/puzzle-piece.svg";
import { DEFAULT_REGISTRY, NpmRegistry } from "../../kernel/extensions";
import { defineSettings, setting } from "../../kernel/settings";
import ExtensionsView from "./ExtensionsView.svelte";
import { ExtensionBrowser } from "./service";

export const extensionsViewSettings = defineSettings({
  registry: setting.string({
    label: "npm registry",
    description: "Where extensions are searched for and downloaded from.",
    default: DEFAULT_REGISTRY,
    live: true,
  }),
});

export const extensionsView = {
  name: "extensions-view",
  Config: extensionsViewSettings,
  inject: ["sidebar", "extensions", "settings", "commands", "keymap"],
  apply(ctx: Context, config: { registry: string }) {
    let registryUrl = config.registry;
    ctx.settings.onLive((change) => {
      registryUrl = change.config.registry as string;
    });
    const registry = new NpmRegistry({ baseUrl: () => registryUrl, fetch: (url, init) => fetch(url, init) });
    const browser = new ExtensionBrowser(ctx.extensions, registry, ctx.settings);
    ctx.sidebar.registerView({
      id: "extensions",
      title: "Extensions",
      icon: puzzlePiece,
      order: 5,
      component: ExtensionsView,
      props: { browser, settings: ctx.settings },
    });
    ctx.commands.register({
      id: "extensions.show",
      title: "Show extensions",
      group: "View",
      keywords: "install plugins npm",
      run: () => ctx.sidebar.open("extensions"),
    });
    ctx.keymap.bind({ id: "extensions.show", keys: "ctrl+shift+x", command: "extensions.show", description: "Show extensions" });
  },
};
