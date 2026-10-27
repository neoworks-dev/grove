// The parts of the diff plugin that show an agent's edit questions, doing nothing, for tests whose
// diff opener only cares about `showInEditor`.

import type { EditDiffOpener } from "../../plugins/agents/editDiffs";

export const noEditDiffs: Omit<EditDiffOpener, "showInEditor"> = {
  hideFromFile: async () => {},
  openTexts: async () => null,
  closePane: () => {},
  diffPaneIds: () => [],
};
