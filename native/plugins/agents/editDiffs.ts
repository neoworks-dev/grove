// Shows an edit the agent asks about as a diff in the editor, for as long as the question waits.
// A written edit (review mode) is drawn over the file itself, which already has it; an edit not
// written yet (ask mode) is a diff pane of the two texts, since the file does not have it yet.

import type { CallDiff } from "./calls";
import type { EditQuestion } from "./editQuestions";

/** What the diff plugin offers for showing an edit and taking it away again. */
export interface EditDiffOpener {
  /** Shows how a file differs from a text, drawn over the file in an editor pane. */
  showInEditor(path: string, base: { text: string; label: string }): Promise<boolean>;
  /** Takes the diff off a file wherever an editor pane draws one over it. */
  hideFromFile(path: string): Promise<void>;
  /** Shows two texts in a diff pane; resolves to the pane, or null when none could be made. */
  openTexts(name: string, oldText: string, newText: string, label: string): Promise<string | null>;
  /** Closes a diff pane, unless it shows something else by now. */
  closePane(leafId: string): void;
  /** The panes that are diff panes. */
  diffPaneIds(): string[];
}

/** What the old side of an edit's diff is called. */
const BASE_LABEL = "before the edit";

/** Diffs being shown for a question. */
export interface ShownEdit {
  /** Resolves once every diff is shown. */
  opened: Promise<void>;
  /** Takes the diffs away again. */
  close(): void;
}

/** Shows every file of an edit question as a diff. */
export function showEditQuestion(diff: EditDiffOpener, question: EditQuestion): ShownEdit {
  const shown = question.diffs.map((change) => showChange(diff, change, question.written));
  return {
    opened: Promise.all(shown).then(() => undefined),
    close: () => {
      for (const closer of shown) {
        void closer.then((close) => close());
      }
    },
  };
}

/** Shows one file's change. Resolves to the function that takes it away again. */
async function showChange(diff: EditDiffOpener, change: CallDiff, written: boolean): Promise<() => void> {
  let oldText = "";
  if (change.oldText !== undefined) {
    oldText = change.oldText;
  }
  if (written) {
    await diff.showInEditor(change.path, { text: oldText, label: BASE_LABEL });
    return () => void diff.hideFromFile(change.path);
  }
  const before = diff.diffPaneIds();
  const leafId = await diff.openTexts(baseName(change.path), oldText, change.newText, BASE_LABEL);
  // A diff pane that was open already is the person's, and stays when the question goes.
  if (leafId === null || before.includes(leafId)) {
    return () => {};
  }
  return () => diff.closePane(leafId);
}

/** The last part of a path, which names the diff pane and picks its language. */
function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return path.slice(slash + 1);
}
