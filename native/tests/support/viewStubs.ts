// The editor element's language methods as stubs that do nothing, for the test views that only
// care about `apply` and `refresh`.

import type { EditorViewMethods } from "../../plugins/editor/service";

/** The methods of an editor view that ask its language server, each doing nothing. */
export function languageStubs(): Pick<EditorViewMethods, "hover" | "definition" | "complete" | "goto"> {
  return {
    hover: async () => {},
    definition: async () => {},
    complete: async () => {},
    goto: async () => {},
  };
}
