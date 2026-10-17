//! The editor's command vocabulary. Keys, the pointer, Svelte, plugins and agents all drive the
//! editor by sending these, so a feature added here reaches every one of them at once.

use serde::{Deserialize, Serialize};

use crate::buffer::Position;
use crate::decorations::Decoration;
use crate::movement::Motion;

/// One thing the editor can be told to do. On the wire it is a JSON object whose `type` names
/// the command, such as `{"type": "move_selections", "motion": "left", "extend": true}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    /// Moves every selection's head by a motion. Extending keeps the anchors; otherwise each
    /// selection becomes a cursor.
    MoveSelections {
        motion: Motion,
        #[serde(default)]
        extend: bool,
    },
    /// Adds a cursor on the line above the topmost selection.
    AddCursorAbove,
    /// Adds a cursor on the line below the bottommost selection.
    AddCursorBelow,
    /// Selects the word at the newest cursor, or adds a selection at the next place the newest
    /// selection's text occurs (Ctrl-D).
    SelectNextOccurrence,
    /// Selects the whole buffer.
    SelectAll,
    /// Back to one cursor, then to no selection (Escape).
    CollapseSelections,
    /// Replaces every selection with one cursor (a click).
    PlaceCursor { at: Position },
    /// Adds a cursor at a position, or removes the one already there (Alt-click).
    ToggleCursor { at: Position },
    /// Moves the newest selection's head to a position, keeping its anchor (Shift-click and drag).
    ExtendNewestTo { at: Position },
    /// Replaces the newest selection with the word at a position (double click).
    SelectWordAt { at: Position },
    /// Types text at every selection, replacing what is selected. While text is being composed
    /// by an input method, it replaces the composed text and ends the composition instead.
    InsertText { text: String },
    /// Deletes every selection, or where there is only a cursor, the text between it and where
    /// the motion would take it. Backspace is `left`, Delete is `right`, and a vim `dw` would
    /// be a motion too.
    Delete { motion: Motion },
    /// Replaces every selection with a line break and the whitespace its line starts with.
    InsertNewline,
    /// Replaces every selection with a tab, or with spaces up to the next tab stop in a file
    /// that is indented with spaces.
    InsertTab,
    /// Takes back the last transaction, with the cursors as they were before it.
    Undo,
    /// Does again what undo took back.
    Redo,
    /// Puts the selected text, or the whole line of an empty selection, in `Outcome::copied`.
    Copy,
    /// Copies like `Copy`, then deletes what was copied.
    Cut,
    /// Pastes text: one line to each selection when it has as many lines as there are selections,
    /// otherwise all of it at each.
    Paste { text: String },
    /// What an input layer makes of Ctrl-V: the view swaps it for a `Paste` of the system
    /// clipboard's text. Applied as it is, it does nothing.
    PasteClipboard,
    /// Writes the buffer to its file. `Outcome::saved` or `Outcome::error` says how it went.
    Save,
    /// Replaces the text being composed by an input method, or the newest selection when there
    /// is none, with text that stays marked as composed.
    SetMarkedText { text: String },
    /// Ends the composition, keeping its text.
    UnmarkText,
    /// Replaces the characters `start..end` (offsets in the text) with text, and puts the
    /// newest cursor after it. This is what an input method asks for when it corrects earlier text.
    ReplaceRange { start: usize, end: usize, text: String },
    /// Replaces everything one source has put on top of the text (errors, blame, a diff) with
    /// `decorations`. An empty list removes the source's. Text and selections are not touched.
    SetDecorations { source: String, decorations: Vec<Decoration> },
}

impl Command {
    /// Whether a key that makes this command should pass on to whatever is behind the editor
    /// when it changed nothing, so Escape in a single plain cursor reaches the app.
    pub fn passes_on_when_unchanged(&self) -> bool {
        *self == Command::CollapseSelections
    }
}

/// What applying a command did, for the view to react to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    /// Whether the selections are different now, so the view has something to redraw and report.
    pub changed: bool,
    /// Whether the view should scroll the newest selection's head into view.
    pub reveal_newest: bool,
    /// Whether the text is different now, which the app learns as a change to the modified state.
    pub text_changed: bool,
    /// What a copy or a cut took, for the view to put on the system clipboard.
    pub copied: Option<String>,
    /// Whether the buffer was written to its file.
    pub saved: bool,
    /// Why a save failed.
    pub error: Option<String>,
    /// Whether the decorations are different now, so every view of the document has to redraw.
    pub decorations_changed: bool,
}
