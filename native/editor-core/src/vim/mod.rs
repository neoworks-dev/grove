//! Vim for the editor. The input layer, [`VimLayer`], is a state machine over modes, counts
//! and pending operators that turns keys into [`crate::Command`]s. The commands it makes carry
//! no positions, only what vim means (`Operate { Delete, Motion { WordForward, 2 } }`), and the
//! rest of this module is the editor state carrying them out at every cursor.

pub(crate) mod block;
mod changes;
mod commands;
mod ex;
pub mod hlsearch;
mod layer;
pub mod motion;
pub mod objects;
mod operate;
mod parse;
pub mod pattern;
mod plan;
pub(crate) mod recall;
pub mod registers;
pub mod search;
pub mod types;

pub use layer::VimLayer;

#[cfg(test)]
mod tests;
