//! The vocabulary vim's commands share between the input layer that makes them and the editor
//! state that carries them out: operators, what they act on, and the requests that go past the
//! editor to the app around it.

use serde::{Deserialize, Serialize};

use crate::movement::Motion;

/// What an operator does to the text it is given.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operator {
    /// `d`: remove the text.
    Delete,
    /// `c`: remove the text and leave the cursor where it was, for insert mode to type over it.
    Change,
    /// `y`: copy the text.
    Yank,
    /// `>`: shift the lines right.
    Indent,
    /// `<`: shift the lines left.
    Outdent,
    /// `gu`: make the text lower case.
    Lowercase,
    /// `gU`: make the text upper case.
    Uppercase,
    /// `g~`: swap the case of the text.
    ToggleCase,
}

/// A text object, such as the word or the quoted string around the cursor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextObject {
    /// `w` and `W`.
    Word { big: bool },
    /// `p`.
    Paragraph,
    /// `"`, `'` and the backtick.
    Quote { quote: char },
    /// `(`, `{`, `[` and `<`, with their closing characters.
    Pair { open: char, close: char },
    /// `t`: the element between a start tag and its end tag.
    Tag,
    /// `s`: a sentence.
    Sentence,
}

/// What a visual selection covers, which decides whether an operator takes characters or lines.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectionKind {
    /// `v`: from the anchor to the head, both included.
    Characters,
    /// `V`: every line the selection touches.
    Lines,
    /// `Ctrl-V`: a rectangle, as one selection on each line.
    Block,
}

/// Where the selections are left when a visual block ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockExit {
    /// The selections stay as they are, for typing at all of them.
    Keep,
    /// One cursor at the corner that was moving.
    Head,
    /// One cursor at the top left corner.
    TopLeft,
    /// One selection from the first corner to the last, as in `v`.
    Range,
}

/// A search for text, from a typed pattern or the last one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchRequest {
    /// `/` and `?` with a pattern. The pattern is remembered for `n` and `N`.
    Pattern { pattern: String, forward: bool },
    /// `n` and `N`: the last pattern, in its own direction or the opposite one.
    Repeat { reverse: bool },
    /// `*` and `#`: the word under the cursor, as a whole word.
    Word { forward: bool },
}

/// What an operator acts on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    /// The text from the cursor to where a motion goes, `count` times.
    Motion { motion: Motion, count: usize },
    /// A text object at the cursor, `inner` (`i`) or around it (`a`).
    Object { object: TextObject, around: bool, count: usize },
    /// `count` lines, starting with the cursor's: the `dd` in `3dd`.
    Lines { count: usize },
    /// What is selected in visual mode.
    Selection { kind: SelectionKind },
    /// The text up to where a search finds its match.
    Search { request: SearchRequest, count: usize },
}

/// Where scrolling puts the cursor's line in the view.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollAlign {
    /// `zt`.
    Top,
    /// `zz`.
    Center,
    /// `zb`.
    Bottom,
}

/// Something an ex command asks of the app around the editor, which the editor cannot do alone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppRequest {
    /// `:q`: close the tab. `discard` (`:q!`) throws away unsaved changes instead of asking.
    CloseTab { discard: bool },
    /// `:e path`: open a file.
    OpenFile { path: String },
    /// `]c` and `[c`: go to the next or previous change of a diff, or of the file against git.
    GotoChange { forward: bool },
}

/// Which lines an ex command works on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineRange {
    /// The cursor's line (the default).
    Current,
    /// Every line (`%`).
    All,
    /// The lines the visual selection touches.
    Selected,
}
