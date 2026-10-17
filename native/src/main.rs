//! Grove's native app: a svelte-gpui window whose Svelte side lives in `ui/`, with the
//! editor drawn by GPUI and registered here as `element("editor")`.
//!
//! ```text
//! bun build.mjs
//! cargo run --release -- --bundle dist/grove-native.js
//! ```
//!
//! `GROVE_OPEN=/path/to/file` opens that file; without it the editor opens a scratch copy of
//! `samples/scratch.rs` in the temp directory, so trying it out never edits real source.
//!
//! The host also runs the sidecar, Grove's main process under Bun, and relays the UI's calls
//! to it (see `sidecar.rs`), and offers the agents plugin the suite daemon's address and a way
//! to start it (see `suite.rs`).

mod diff;
mod editor;
mod git;
mod lsp;
mod sidecar;
mod suite;

use std::path::PathBuf;

use editor::{Editor, SharedDocuments, Signals};
use lsp::LspStore;
use serde_json::json;
use sidecar::{Sidecar, SidecarConfig};
use svelte_gpui::gpui::AppContext as _;
use svelte_gpui::{CommandError, Commands, Elements, Options};

/// The sample code the scratch file starts from.
const SCRATCH_SAMPLE: &str = include_str!("../samples/scratch.rs");

fn main() {
    let file = initial_file();
    let commands = Commands::new()
        .command("initial_file", move |_| Ok::<_, CommandError>(json!(file)))
        .command("initial_repo", |_| Ok::<_, CommandError>(json!(initial_repo())));
    let sidecar = Sidecar::start(SidecarConfig::from_environment(), commands.emitter());
    let commands = sidecar.commands(commands);
    let commands = suite::register(commands);
    let documents = SharedDocuments::new(commands.emitter());
    let commands = documents.register(commands);
    let signals = Signals::default();
    let lsp = LspStore::new(documents.clone(), commands.emitter(), signals.clone());
    let commands = lsp.register(commands);
    let commands = git::register(commands);
    let commands = diff::register(commands, documents.clone());
    let lsp_for_views = lsp.clone();
    let elements = Elements::new().register("editor", move |host, cx| {
        let documents = documents.clone();
        let lsp = lsp_for_views.clone();
        let signals = signals.clone();
        cx.new(|cx| Editor::new(documents, lsp, &signals, host, cx))
    });
    svelte_gpui::run(options().commands(commands).elements(elements));
    lsp.shutdown();
    sidecar.stop();
}

/// The file to open at start: `GROVE_OPEN` when it is set, else a fresh scratch copy of the sample.
fn initial_file() -> String {
    if let Ok(path) = std::env::var("GROVE_OPEN") {
        return path;
    }
    let scratch = scratch_path();
    if let Err(error) = std::fs::write(&scratch, SCRATCH_SAMPLE) {
        eprintln!("could not write {}: {error}", scratch.display());
    }
    scratch.display().to_string()
}

/// The repository to open at start: `GROVE_REPO` when it is set, else empty, and the app then
/// reopens the last repository it had.
fn initial_repo() -> String {
    std::env::var("GROVE_REPO").unwrap_or_default()
}

/// Where the scratch copy lives in the system temp directory.
fn scratch_path() -> PathBuf {
    std::env::temp_dir().join("grove-native-scratch.rs")
}

/// The host's options from the command line, which names the bundle to run.
fn options() -> Options {
    Options::from_command_line().unwrap_or_else(|| {
        eprintln!("usage: grove-native --bundle dist/grove-native.js");
        std::process::exit(2);
    })
}
