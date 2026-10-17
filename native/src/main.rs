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

mod editor;

use std::path::PathBuf;

use editor::Editor;
use serde_json::json;
use svelte_gpui::gpui::AppContext as _;
use svelte_gpui::{CommandError, Commands, Elements, Options};

/// The sample code the scratch file starts from.
const SCRATCH_SAMPLE: &str = include_str!("../samples/scratch.rs");

fn main() {
    let file = initial_file();
    let commands = Commands::new().command("initial_file", move |_| Ok::<_, CommandError>(json!(file)));
    let elements = Elements::new().register("editor", |host, cx| cx.new(|cx| Editor::new(host, cx)));
    svelte_gpui::run(options().commands(commands).elements(elements));
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
