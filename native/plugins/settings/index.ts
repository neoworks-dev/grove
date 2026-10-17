// The settings page plugin. It draws the page in the `overlay` slot and opens it with the
// `view.preferences` command, which the View menu and the header's settings button already run.
// The page itself is generic: it lists the profile's rows and builds a form from the schema each
// plugin declares, so a plugin gets a settings page by declaring its `Config`.

import type { Context } from "@neoworks/extension-system";
import { KeyPriority } from "../../kernel/keymap";
import SettingsOverlay from "./SettingsOverlay.svelte";
import { SettingsViewState } from "./state";

export const settingsView = {
  name: "settings-view",
  // The only way to reach the page, so a profile cannot switch it off from inside it.
  essential: true,
  inject: ["slots", "commands", "keymap", "settings"],
  apply(ctx: Context) {
    const view = new SettingsViewState();
    ctx.slots.register("overlay", {
      id: "settings",
      order: 50,
      component: SettingsOverlay,
      props: { view, settings: ctx.settings },
    });
    ctx.commands.register({
      id: "view.preferences",
      title: "Open settings",
      group: "View",
      keywords: "preferences configuration plugins",
      run: () => view.open(),
    });
    ctx.keymap.bind({ id: "view.preferences", keys: "ctrl+,", command: "view.preferences", description: "Settings" });
    // Below the palette's tier, so Escape closes the palette first when it is open over the page.
    ctx.keymap.subscribe(KeyPriority.menu, (event) => {
      if (!view.isOpen()) {
        return false;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        view.close();
        return true;
      }
      return false;
    });
  },
};
