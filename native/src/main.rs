//! Grove's native app: a svelte-gpui window whose Svelte side lives in `ui/`, with the
//! editor drawn by GPUI and registered here as `element("editor")`.
//!
//! ```text
//! bun build.mjs
//! cargo run --release -- --bundle dist/grove-native.js
//! ```

mod editor;

use editor::Editor;
use serde_json::json;
use svelte_gpui::gpui::AppContext as _;
use svelte_gpui::{CommandError, Commands, Elements, Options};

fn main() {
    let commands = Commands::new().command("initial_file", |_| Ok::<_, CommandError>(json!(initial_file())));
    let elements = Elements::new().register("editor", |host, cx| cx.new(|cx| Editor::new(host, cx)));
    svelte_gpui::run(options().commands(commands).elements(elements));
}

/// The file to open at start: `GROVE_OPEN` when it is set, else this program's own source.
fn initial_file() -> String {
    if let Ok(path) = std::env::var("GROVE_OPEN") {
        return path;
    }
    concat!(env!("CARGO_MANIFEST_DIR"), "/src/editor/mod.rs").to_string()
}

/// The host's options from the command line, which names the bundle to run.
fn options() -> Options {
    Options::from_command_line().unwrap_or_else(|| {
        eprintln!("usage: grove-native --bundle dist/grove-native.js");
        std::process::exit(2);
    })
}
