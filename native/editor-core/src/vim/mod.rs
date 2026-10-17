//! Vim for the editor. The input layer, [`VimLayer`], is a state machine over modes, counts
//! and pending operators that turns keys into [`crate::Command`]s. The commands it makes carry
//! no positions, only what vim means (`Operate { Delete, Motion { WordForward, 2 } }`), and the
//! rest of this module is the editor state carrying them out at every cursor.

mod changes;
mod commands;
pub mod motion;
pub mod objects;
mod operate;
mod plan;
pub mod registers;
pub mod search;
pub mod types;
