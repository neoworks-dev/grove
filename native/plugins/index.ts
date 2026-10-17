// The core plugins this bundle contains, by the name a profile row gives them. QuickJS loads one
// bundle, so every core plugin is imported here and the profile selects and configures them.

import type { PluginCatalog } from "../kernel/profile";
import { editor } from "./editor";
import { editorPosition } from "./editor-position";
import { failing } from "./failing";
import { frame } from "./frame";

export const corePlugins: PluginCatalog = {
  frame,
  editor,
  "editor-position": editorPosition,
  failing,
};
