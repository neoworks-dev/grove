// The which-key plugin: while a key sequence is half typed, such as the first key of `ctrl+k w`,
// a card in the `overlay` slot lists the keys that can finish it. It reads the keymap's pending
// state, so bindings from any plugin show up without registering anything. It does the same for a
// half-typed vim command in the editor, such as `g` or `d`, from the table in `vimKeys.ts`.

import type { Context } from "@neoworks/extension-system";
import WhichKey from "./WhichKey.svelte";

export const whichKey = {
  name: "which-key",
  inject: ["slots", "keymap", "editor"],
  apply(ctx: Context) {
    const props = { keymap: ctx.keymap, editor: ctx.editor };
    ctx.slots.register("overlay", { id: "which-key", order: 10, component: WhichKey, props });
  },
};
