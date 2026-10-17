// What the editor plugin's components share: the open file, whether it has unsaved changes, where
// the cursor is, and the element's methods. The editor element itself lives in `EditorMain`; the
// status bar entries read this instead of reaching into it.

/** The methods `src/editor/mod.rs` gives the editor element. */
export interface EditorMethods {
  apply(command: { type: string }): Promise<{ changed: boolean }>;
}

class EditorState {
  fileSummary = $state("");
  message = $state("");
  modified = $state(false);
  row = $state(0);
  column = $state(0);
  cursorCount = $state(0);
  /** The mounted editor element, or null while none is. */
  element: EditorMethods | null = null;

  /** The file name with a dot after it while there are unsaved changes, and any message after that. */
  describeFile(): string {
    let text = this.fileSummary;
    if (this.modified) {
      text += " ●";
    }
    if (this.message) {
      text += ` · ${this.message}`;
    }
    return text;
  }

  /** Line and column of the newest cursor, counted from one, and how many cursors there are. */
  describePosition(): string {
    if (this.cursorCount === 0) {
      return "";
    }
    const place = `Ln ${this.row + 1}, Col ${this.column + 1}`;
    if (this.cursorCount === 1) {
      return place;
    }
    return `${place} · ${this.cursorCount} cursors`;
  }

  /** Saves the open file through the editor's own command, as its Ctrl-S would. */
  async save(): Promise<void> {
    if (!this.element) {
      throw new Error("there is no editor to save from");
    }
    await this.element.apply({ type: "save" });
  }

  /** Forgets the editor and what it reported, for when the plugin unloads. */
  reset(): void {
    this.fileSummary = "";
    this.message = "";
    this.modified = false;
    this.row = 0;
    this.column = 0;
    this.cursorCount = 0;
    this.element = null;
  }
}

export const editorState = new EditorState();
