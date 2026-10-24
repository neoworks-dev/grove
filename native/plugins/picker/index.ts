// The picker plugin: the `picker` service and the overlay that draws it, for plugins that find
// things and open them, such as the file picker and the content search. The overlay claims bare
// keys while it is open so no binding fires under it, and closes on Escape.

import type { Context } from "@neoworks/extension-system";
import { KeyPriority } from "../../kernel/keymap";
import PickerOverlay from "./PickerOverlay.svelte";
import { PickerService } from "./service";

export const picker = {
  name: "picker",
  inject: ["slots", "keymap", "editor", "palette"],
  apply(ctx: Context) {
    const service = new PickerService(ctx);
    ctx.slots.register("overlay", { id: "picker", order: 101, component: PickerOverlay, props: { picker: service, editor: ctx.editor } });
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
