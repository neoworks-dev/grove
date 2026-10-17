//! The editor's command vocabulary. Keys, the pointer, Svelte, plugins and agents all drive the
//! editor by sending these, so a feature added here reaches every one of them at once.

use serde::{Deserialize, Serialize};

use crate::buffer::Position;
use crate::completion::RangeEdit;
use crate::decorations::Decoration;
use crate::indent::IndentStyle;
use crate::movement::Motion;
use crate::vim::types::{
    AppRequest, BlockExit, LineRange, Operator, ScrollAlign, SearchRequest, SelectionKind, Target, TextObject,
};

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
    /// Adds one level of indentation to every line a selection touches.
    Indent,
    /// Takes one level of indentation off every line a selection touches (Shift-Tab).
    Outdent,
    /// Sets how this file is indented, which Tab, Enter and shifting lines follow from then on.
    SetIndent { style: IndentStyle },
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
    /// Applies several replacements at once, as a language server's text edits or a formatter's
    /// output ask for. The positions are in the text as it is now, and the whole set is one step
    /// for undo. Cursors keep their place in the text around the edits.
    ApplyEdits { edits: Vec<RangeEdit> },
    /// Replaces everything one source has put on top of the text (errors, blame, a diff) with
    /// `decorations`. An empty list removes the source's. Text and selections are not touched.
    SetDecorations { source: String, decorations: Vec<Decoration> },
    /// Accepts a completion: replaces `before` characters before every cursor and `after`
    /// characters after it with `text`, which is expanded as a snippet when `snippet` is set.
    /// The edits in `additional` (an import the completion needs) go in once, at the positions
    /// they give in the text as it is now.
    InsertCompletion {
        before: usize,
        #[serde(default)]
        after: usize,
        text: String,
        #[serde(default)]
        snippet: bool,
        #[serde(default)]
        additional: Vec<RangeEdit>,
    },
    /// Selects the places of the next tab stop of the snippet being filled in.
    SnippetNext,
    /// Selects the places of the previous tab stop of the snippet being filled in.
    SnippetPrevious,
    /// Starts jump labels in the view: the person types what to look for, every match in view gets
    /// a label, and typing one runs `then` with the place it stands for, where `then` has a
    /// `Motion::To` as a placeholder. Without one it moves the cursor there.
    StartJump {
        #[serde(default = "move_to_jump_target")]
        then: Box<Command>,
    },
    /// Does nothing. A layer returns it for a key it has used up, so the key is neither typed
    /// into the text nor passed on to the app.
    Noop,
    /// Reports a failure for the person to read, such as an ex command that does not exist.
    Fail { message: String },
    /// Asks the app around the editor for something the editor cannot do, such as closing the tab.
    Request { request: AppRequest },
    /// Vim's move: every selection's head goes where a motion made `count` times takes it, and
    /// stays on a character of its line. Extending keeps the anchors, as in visual mode.
    VimMove {
        motion: Motion,
        count: usize,
        #[serde(default)]
        extend: bool,
    },
    /// Applies an operator at every cursor, to what the target covers there. What it removes or
    /// copies goes in a register, the unnamed one when none is given.
    Operate {
        operator: Operator,
        target: Target,
        #[serde(default)]
        register: Option<char>,
    },
    /// Puts a register's text after the cursor, or before it, `count` times. Over a visual
    /// selection it replaces the selection. A register that stands for the system clipboard
    /// is filled in by the view, in `clipboard`.
    Put {
        #[serde(default)]
        register: Option<char>,
        before: bool,
        count: usize,
        /// `gp` and `gP`: leave the cursor after the text.
        #[serde(default)]
        cursor_after: bool,
        #[serde(default)]
        over: Option<SelectionKind>,
        #[serde(default)]
        clipboard: Option<String>,
    },
    /// Joins a line with the ones after it (`J`), or the lines a visual selection touches.
    JoinLines {
        count: usize,
        #[serde(default)]
        from_selection: bool,
    },
    /// Replaces `count` characters from each cursor with one character (`r`), or every
    /// character of a visual selection.
    ReplaceChars {
        character: char,
        count: usize,
        #[serde(default)]
        over: Option<SelectionKind>,
    },
    /// Types over the characters after each cursor, as replace mode does.
    Overwrite { text: String },
    /// Opens an empty line below each cursor's line, or above it, with its indentation (`o`, `O`).
    OpenLine { above: bool },
    /// Replaces a pattern with text on some lines (`:s`).
    Substitute {
        range: LineRange,
        pattern: String,
        replacement: String,
        global: bool,
        /// The `i` flag: letters match in either case.
        #[serde(default)]
        ignore_case: bool,
    },
    /// Moves every cursor to the next match of a search.
    VimSearch {
        request: SearchRequest,
        count: usize,
        #[serde(default)]
        extend: bool,
    },
    /// Selects the text object around each cursor (`viw`).
    SelectObject { object: TextObject, around: bool, count: usize },
    /// Ctrl-N: selects the word under the newest cursor, or with `add` adds the next place the
    /// newest selection's text occurs. A selection's head is its last character.
    SelectNextMatch { add: bool },
    /// Collapses every selection to its head, keeping every cursor (leaving visual mode).
    CollapseToHeads,
    /// Swaps each selection's anchor and head, so the other end moves (`o` in visual mode).
    SwapSelectionEnds,
    /// Moves any cursor that is past the last character of its line back onto it.
    ClampCursors,
    /// Opens or closes an undo group: everything done while one is open, such as an insert
    /// session, is a single step for undo.
    GroupUndo { open: bool },
    /// Scrolls the view so the newest cursor's line is at the top, middle or bottom.
    ScrollTo { align: ScrollAlign },
    /// `Ctrl-V`: starts a visual block at the cursor, or at the ends of the selection.
    BlockStart,
    /// Moves the visual block's moving corner as a motion would move a cursor.
    BlockMove { motion: Motion, count: usize },
    /// `o` in a visual block: the other corner moves.
    BlockSwap,
    /// Ends the visual block, with the selections left as `exit` says.
    BlockEnd { exit: BlockExit },
    /// `I` and `A` in a visual block: a cursor on each line, to type at all of them.
    BlockInsert { append: bool },
    /// `:noh`: stops marking the matches of the last search.
    ClearSearchHighlight,
    /// Remembers the selection about to be left, so `gv` and `.` can use it.
    RememberVisual { kind: SelectionKind },
    /// `gv`: selects the last visual selection again.
    ReselectVisual,
    /// Selects from the cursor as much text as the last visual selection covered, for `.`.
    SelectLastExtent,
    /// Notes the cursor's place as one `Ctrl-O` can come back to.
    PushJump,
    /// `Ctrl-O`: goes back in the jump list.
    JumpOlder { count: usize },
    /// `Ctrl-I`: goes forward in the jump list.
    JumpNewer { count: usize },
    /// Backspace in replace mode: puts back what the last typed character covered.
    RestoreOverwritten,
    /// Scrolls the view down by some rows, or up when negative, without moving the cursor (`Ctrl-F`).
    ScrollView { rows: isize },
    /// Remembers the newest cursor's place under a letter (`m`).
    SetMark { name: char },
    /// Goes to a place remembered with `SetMark` (`'` and the backtick).
    JumpToMark {
        name: char,
        linewise: bool,
        #[serde(default)]
        extend: bool,
    },
}

/// What a jump does when it is not told: move the cursor to the place.
fn move_to_jump_target() -> Box<Command> {
    Box::new(Command::MoveSelections { motion: Motion::To(Position::default()), extend: false })
}

impl Command {
    /// This command with the place of a jump put where it has a placeholder: in the motion of a
    /// move, or of an operator's target. A command that has no such place is as it was.
    pub fn with_jump_target(&self, at: Position) -> Command {
        match self {
            Command::MoveSelections { motion: Motion::To(_), extend } => {
                Command::MoveSelections { motion: Motion::To(at), extend: *extend }
            }
            Command::VimMove { motion: Motion::To(_), count, extend } => {
                Command::VimMove { motion: Motion::To(at), count: *count, extend: *extend }
            }
            Command::Operate { operator, target: Target::Motion { motion: Motion::To(_), count }, register } => {
                let target = Target::Motion { motion: Motion::To(at), count: *count };
                Command::Operate { operator: *operator, target, register: *register }
            }
            other => other.clone(),
        }
    }

    /// Whether a key that makes this command should pass on to whatever is behind the editor
    /// when it changed nothing, so Escape in a single plain cursor reaches the app.
    pub fn passes_on_when_unchanged(&self) -> bool {
        *self == Command::CollapseSelections
    }

    /// Whether the command can change the text. A read-only view refuses the ones that can, and a
    /// command nobody has listed as harmless counts as one that can.
    pub fn changes_text(&self) -> bool {
        match self {
            Command::MoveSelections { .. }
            | Command::AddCursorAbove
            | Command::AddCursorBelow
            | Command::SelectNextOccurrence
            | Command::SelectAll
            | Command::CollapseSelections
            | Command::PlaceCursor { .. }
            | Command::ToggleCursor { .. }
            | Command::ExtendNewestTo { .. }
            | Command::SelectWordAt { .. }
            | Command::Copy
            | Command::UnmarkText
            | Command::SetDecorations { .. }
            | Command::Noop
            | Command::Fail { .. }
            | Command::Request { .. }
            | Command::VimMove { .. }
            | Command::VimSearch { .. }
            | Command::SelectObject { .. }
            | Command::SelectNextMatch { .. }
            | Command::CollapseToHeads
            | Command::SwapSelectionEnds
            | Command::ClampCursors
            | Command::GroupUndo { .. }
            | Command::ScrollTo { .. }
            | Command::ScrollView { .. }
            | Command::ClearSearchHighlight
            | Command::BlockStart
            | Command::BlockMove { .. }
            | Command::BlockSwap
            | Command::BlockEnd { .. }
            | Command::BlockInsert { .. }
            | Command::RememberVisual { .. }
            | Command::ReselectVisual
            | Command::SelectLastExtent
            | Command::PushJump
            | Command::JumpOlder { .. }
            | Command::JumpNewer { .. }
            | Command::SetMark { .. }
            | Command::JumpToMark { .. } => false,
            Command::Operate { operator, .. } => *operator != Operator::Yank,
            _ => true,
        }
    }

    /// Whether the command is one of vim's, which `vim::commands` carries out.
    pub fn is_vim(&self) -> bool {
        matches!(
            self,
            Command::Noop
                | Command::Fail { .. }
                | Command::Request { .. }
                | Command::VimMove { .. }
                | Command::Operate { .. }
                | Command::Put { .. }
                | Command::JoinLines { .. }
                | Command::ReplaceChars { .. }
                | Command::Overwrite { .. }
                | Command::OpenLine { .. }
                | Command::Substitute { .. }
                | Command::VimSearch { .. }
                | Command::SelectObject { .. }
                | Command::SelectNextMatch { .. }
                | Command::CollapseToHeads
                | Command::SwapSelectionEnds
                | Command::ClampCursors
                | Command::GroupUndo { .. }
                | Command::ScrollTo { .. }
                | Command::ScrollView { .. }
                | Command::ClearSearchHighlight
                | Command::BlockStart
                | Command::BlockMove { .. }
                | Command::BlockSwap
                | Command::BlockEnd { .. }
                | Command::BlockInsert { .. }
                | Command::RememberVisual { .. }
                | Command::ReselectVisual
                | Command::SelectLastExtent
                | Command::PushJump
                | Command::JumpOlder { .. }
                | Command::JumpNewer { .. }
                | Command::RestoreOverwritten
                | Command::SetMark { .. }
                | Command::JumpToMark { .. }
        )
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
    /// Where the view should scroll the newest cursor's line to.
    pub scroll: Option<ScrollAlign>,
    /// How many rows the view should scroll down, or up when negative.
    pub scroll_rows: Option<isize>,
    /// The command a jump runs once a place is chosen, as the command made the view start one.
    pub jump: Option<Command>,
    /// Whether the way the file is indented is different now, which the app learns for its status bar.
    pub indent_changed: bool,
    /// What the app is asked to do, as the command made a `Request`.
    pub request: Option<AppRequest>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::movement::Motion;
    use crate::vim::types::Target;

    #[test]
    fn moving_and_copying_leave_the_text_alone_and_typing_and_deleting_do_not() {
        assert!(!Command::MoveSelections { motion: Motion::Left, extend: true }.changes_text());
        assert!(!Command::Copy.changes_text());
        assert!(Command::InsertText { text: "x".into() }.changes_text());
        assert!(Command::Delete { motion: Motion::Left }.changes_text());
        assert!(Command::Undo.changes_text());
        assert!(Command::Save.changes_text());
    }

    #[test]
    fn a_yank_leaves_the_text_alone_and_the_other_operators_do_not() {
        let target = Target::Motion { motion: Motion::WordForward { big: false }, count: 1 };
        let operate = |operator| Command::Operate { operator, target: target.clone(), register: None };
        assert!(!operate(Operator::Yank).changes_text());
        assert!(operate(Operator::Delete).changes_text());
    }
}
