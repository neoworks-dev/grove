// Shows an edit the agent asks about as a diff tab in the editor, for as long as the question
// waits. A written edit (review mode) is the file's own document against the text before it; an
// edit not written yet (ask mode) is a document of the new text that belongs to no file, since the
// file does not have it yet.

import type { CallDiff } from "./calls";
import type { EditQuestion } from "./editQuestions";

/** A diff tab: the pane it is in and the document it shows. */
export interface EditDiffTab {
  leafId: string;
  documentId: number;
}

/** What the diff plugin offers for showing an edit and taking it away again. */
export interface EditDiffOpener {
  /** Shows how a file differs from a text in a diff tab. */
  showInEditor(path: string, base: { text: string; label: string }): Promise<boolean>;
  /** Closes every diff tab of a file. */
  hideFromFile(path: string): Promise<void>;
  /** Shows two texts in a diff tab; resolves to the tab, or null when there is no editor pane. */
  showTextsInEditor(name: string, oldText: string, newText: string, label: string): Promise<EditDiffTab | null>;
  /** Closes a diff tab. */
  closeDiffTab(tab: EditDiffTab): Promise<void>;
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
  const tab = await diff.showTextsInEditor(baseName(change.path), oldText, change.newText, BASE_LABEL);
  if (tab === null) {
    return () => {};
  }
  return () => void diff.closeDiffTab(tab);
}

/** The last part of a path, which names the diff tab and picks its language. */
function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return path.slice(slash + 1);
}
