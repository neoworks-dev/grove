// A small status bar entry showing the focused pane's cursor position. It is its own plugin so a
// profile row can switch it off, which shows how a profile layer shapes the UI.

import type { Context } from "@neoworks/extension-system";
import EditorPosition from "./EditorPosition.svelte";

export const editorPosition = {
  name: "editor-position",
  inject: ["slots", "editor"],
  apply(ctx: Context) {
    ctx.slots.register("statusbar", {
      id: "editor.position",
      order: 20,
      component: EditorPosition,
      props: { align: "right", service: ctx.editor },
    });
  },
};
