// The palette plugin: the `palette` service, the overlay that draws it, and the command and keys
// that open it. The overlay claims bare keys while it is open so no binding fires under it, and
// lets chords through so the opening chord can close it again.

import type { Context } from "@neoworks/extension-system";
import { KeyPriority } from "../../kernel/keymap";
import { defineSettings, setting } from "../../kernel/settings";
import PaletteOverlay from "./PaletteOverlay.svelte";
import { PaletteService } from "./service";

export const paletteSettings = defineSettings({
  keys: setting.keybinding({
    label: "Open the palette",
    description: "The key sequence that shows the command palette.",
    default: "ctrl+shift+p",
  }),
});

export const palette = {
  name: "palette",
  Config: paletteSettings,
  inject: ["slots", "commands", "keymap"],
  apply(ctx: Context, config: { keys: string }) {
    const service = new PaletteService(ctx);
    ctx.slots.register("overlay", { id: "palette", order: 100, component: PaletteOverlay, props: { palette: service } });
    ctx.commands.register({ id: "palette.open", title: "Command palette", group: "View", run: () => service.toggle() });
    if (config.keys !== "") {
      ctx.keymap.bind({ id: "palette.open", keys: config.keys, command: "palette.open", description: "Command palette" });
    }
    ctx.keymap.bind({ id: "palette.open.f1", keys: "f1", command: "palette.open", description: "Command palette" });
    ctx.keymap.subscribe(KeyPriority.overlay, (event) => {
      if (!service.isOpen()) {
        return false;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        service.close();
        return true;
      }
      return !(event.ctrlKey || event.altKey || event.metaKey);
    });
  },
};
