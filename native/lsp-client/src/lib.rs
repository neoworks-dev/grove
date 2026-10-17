//! A language server client for the native editor. The process and its JSON-RPC conversation
//! live in [`client`]; the rest is the pure part, which needs no window and no server to test:
//! document sync, diagnostics as decorations, completion items and their fuzzy matching, and
//! the markdown hovers are written in.

pub mod actions;
pub mod client;
pub mod completion;
pub mod config;
pub mod diagnostics;
pub mod edits;
pub mod glob;
pub mod highlights;
pub mod initialize;
pub mod inlay;
pub mod markdown;
pub mod protocol;
pub mod registry;
pub mod rpc;
pub mod signature;
pub mod sync;
pub mod tools;
pub mod uri;
