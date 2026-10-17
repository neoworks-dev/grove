// The core plugins this bundle contains, by the name a profile row gives them. QuickJS loads one
// bundle, so every core plugin is imported here and the profile selects and configures them.

import type { PluginCatalog } from "../kernel/profile";
import { editor } from "./editor";
import { editorPosition } from "./editor-position";
import { brokenEntry, failing } from "./failing";
import { frame } from "./frame";
import { header } from "./header";
import { layout } from "./layout";
import { coreMenu, menus } from "./menus";
import { panel } from "./panel";
import { placeholderPanel, placeholderSidebar } from "./placeholders";
import { palette } from "./palette";
import { rails } from "./rails";
import { settingsView } from "./settings";
import { sidebar } from "./sidebar";
import { statusbar } from "./statusbar";
import { coreThemes, theme, themePicker } from "./theme";
import { whichKey } from "./which-key";

export const corePlugins: PluginCatalog = {
  frame,
  header,
  menus,
  "core-menu": coreMenu,
  theme,
  "core-themes": coreThemes,
  "theme-picker": themePicker,
  palette,
  "settings-view": settingsView,
  "which-key": whichKey,
  rails,
  sidebar,
  statusbar,
  panel,
  layout,
  editor,
  "editor-position": editorPosition,
  "placeholder-sidebar": placeholderSidebar,
  "placeholder-panel": placeholderPanel,
  failing,
  "broken-entry": brokenEntry,
};
