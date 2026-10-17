//! A language server client for the native editor. The process and its JSON-RPC conversation
//! live in [`client`]; the rest is the pure part, which needs no window and no server to test:
//! document sync, diagnostics as decorations, completion items and their fuzzy matching, and
//! the markdown hovers are written in.

pub mod client;
pub mod completion;
pub mod diagnostics;
pub mod initialize;
pub mod markdown;
pub mod protocol;
pub mod registry;
pub mod rpc;
pub mod sync;
pub mod uri;
