//! The editor without a window: the text, the selections, and every way of changing them.
//!
//! Nothing here knows about GPUI. Input layers turn keys into [`Command`]s, Svelte, plugins and
//! agents send the same commands as JSON, and [`EditorState::apply`] is the one place that
//! changes the buffer and the selections. The GPUI view only paints the state and forwards input.

pub mod anchor;
pub mod buffer;
pub mod clipboard;
pub mod command;
pub mod completion;
pub mod decorations;
pub mod diff;
pub mod display;
pub mod documents;
pub mod edit;
pub mod editing;
pub mod guides;
pub mod history;
pub mod indent;
pub mod indenting;
pub mod jump;
pub mod keymap;
pub mod movement;
pub mod occurrences;
pub mod selections;
pub mod snippet;
pub mod state;
pub mod syntax;
pub mod vim;

pub use anchor::{Anchor, AnchorId, Bias};
pub use buffer::{Buffer, ContentChange, LineEnding, Position, Utf16Point};
pub use command::{Command, Outcome};
pub use completion::RangeEdit;
pub use decorations::{
    Decoration, DecorationKind, GutterMark, Placement, SourceFilter, Tone, Underline, UnderlineKind,
};
pub use documents::{Applied, Document, DocumentId, DocumentSummary, Documents, Opened};
pub use edit::{Edit, Edits};
pub use indent::{IndentSource, IndentStyle};
pub use keymap::{
    CursorShape, InputContext, InputLayer, InputStatus, KeyInput, Modifiers, SelectionStyle, StandardKeymap,
};
pub use movement::Motion;
pub use selections::{Selection, Selections};
pub use syntax::Scope;
pub use state::EditorState;
pub use vim::VimLayer;
