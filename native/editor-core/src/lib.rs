//! The editor without a window: the text, the selections, and every way of changing them.
//!
//! Nothing here knows about GPUI. Input layers turn keys into [`Command`]s, Svelte, plugins and
//! agents send the same commands as JSON, and [`EditorState::apply`] is the one place that
//! changes the buffer and the selections. The GPUI view only paints the state and forwards input.

pub mod buffer;
pub mod command;
pub mod display;
pub mod keymap;
pub mod movement;
pub mod selections;
pub mod state;

pub use buffer::{Buffer, Position};
pub use command::{Command, Outcome};
pub use keymap::{InputContext, InputLayer, KeyInput, Modifiers, StandardKeymap};
pub use movement::Motion;
pub use selections::{Selection, Selections};
pub use state::EditorState;
