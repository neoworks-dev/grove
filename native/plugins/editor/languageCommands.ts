// The commands and keys that ask the language server something through the focused editor. Kept
// apart from the plugin so a test can read them without the host, and so the ids are in one
// place: the editor's context menu lists these commands by their ids.

import type { ViewAction } from "./service";

/** A command that makes the focused editor do one of its language actions. */
export interface LanguageCommand {
  id: string;
  title: string;
  group: string;
  action: ViewAction;
}

export const LANGUAGE_COMMANDS: LanguageCommand[] = [
  { id: "editor.showHover", title: "Show hover", group: "Editor", action: "hover" },
  { id: "editor.goToDefinition", title: "Go to definition", group: "Go", action: "definition" },
  { id: "editor.triggerSuggest", title: "Trigger completion", group: "Editor", action: "complete" },
  { id: "editor.findReferences", title: "Find all references", group: "Go", action: "references" },
  { id: "editor.goToTypeDefinition", title: "Go to type definition", group: "Go", action: "typeDefinition" },
  { id: "editor.goToImplementation", title: "Go to implementations", group: "Go", action: "implementation" },
  { id: "editor.rename", title: "Rename symbol", group: "Editor", action: "rename" },
  { id: "editor.codeAction", title: "Show code actions (quick fix)", group: "Editor", action: "codeActions" },
  { id: "editor.triggerParameterHints", title: "Show signature help", group: "Editor", action: "signature" },
  { id: "editor.formatDocument", title: "Format document", group: "Editor", action: "format" },
];

/** The keys of those commands, by command id. */
export const LANGUAGE_KEYS: { command: string; keys: string; description: string }[] = [
  { command: "editor.showHover", keys: "ctrl+k ctrl+i", description: "Show hover" },
  { command: "editor.goToDefinition", keys: "f12", description: "Go to definition" },
  { command: "editor.findReferences", keys: "shift+f12", description: "Find all references" },
  { command: "editor.goToImplementation", keys: "ctrl+f12", description: "Go to implementations" },
  { command: "editor.rename", keys: "f2", description: "Rename symbol" },
  { command: "editor.codeAction", keys: "ctrl+.", description: "Show code actions" },
  { command: "editor.triggerParameterHints", keys: "ctrl+shift+space", description: "Show signature help" },
  { command: "editor.formatDocument", keys: "alt+shift+f", description: "Format document" },
];
