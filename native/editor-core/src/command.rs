//! The editor's command vocabulary. Keys, the pointer, Svelte, plugins and agents all drive the
//! editor by sending these, so a feature added here reaches every one of them at once.

use serde::{Deserialize, Serialize};

use crate::buffer::Position;
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
}

impl Command {
    /// Whether a key that makes this command should pass on to whatever is behind the editor
    /// when it changed nothing, so Escape in a single plain cursor reaches the app.
    pub fn passes_on_when_unchanged(&self) -> bool {
        *self == Command::CollapseSelections
    }
}

/// What applying a command did, for the view to react to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    /// Whether the selections are different now, so the view has something to redraw and report.
    pub changed: bool,
    /// Whether the view should scroll the newest selection's head into view.
    pub reveal_newest: bool,
}
