//! The clipboard's image, for pasting into the agent's composer.
//!
//! The webview-style `clipboard.read()` only gives text, so one command, `clipboard_image`, saves
//! the clipboard's image to a file and answers with its path, or `null` when the clipboard holds no
//! image or neither `wl-paste` (Wayland) nor `xclip` (X11) is installed. The daemon takes attached
//! images by path, which is why it is saved. The tools and the order of image types follow neo term
//! (apps/term attach.rs).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use svelte_gpui::{CommandError, Commands};

/// The image types taken, most wanted first, with the extension each is saved under.
const IMAGE_TYPES: &[(&str, &str)] = &[("image/png", "png"), ("image/jpeg", "jpg"), ("image/webp", "webp"), ("image/gif", "gif")];

/// Registers the `clipboard_image` command.
pub fn register(commands: Commands) -> Commands {
    commands.command("clipboard_image", |_| Ok::<_, CommandError>(json!(paste_image().map(|path| path.to_string_lossy().to_string()))))
}

/// Saves the clipboard's image to a file and returns its path; none when it holds no image.
fn paste_image() -> Option<PathBuf> {
    let (extension, bytes) = if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        read_with(&["wl-paste", "--list-types"], |mime| vec!["wl-paste", "--no-newline", "--type", mime])
    } else {
        read_with(&["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"], |mime| {
            vec!["xclip", "-selection", "clipboard", "-t", mime, "-o"]
        })
    }?;
    save(&std::env::temp_dir().join("grove-paste"), &bytes, extension)
}

/// Lists the clipboard's types with `list`, picks an image type and reads it with `read`.
fn read_with(list: &[&str], read: impl Fn(&str) -> Vec<&str>) -> Option<(&'static str, Vec<u8>)> {
    let types = run(list)?;
    let (mime, extension) = pick_type(&String::from_utf8_lossy(&types))?;
    let bytes = run(&read(mime))?;
    if bytes.is_empty() {
        return None;
    }
    Some((extension, bytes))
}

/// The most wanted image type among the clipboard's types, one per line.
fn pick_type(types: &str) -> Option<(&'static str, &'static str)> {
    let offered: Vec<&str> = types.lines().map(str::trim).collect();
    IMAGE_TYPES.iter().find(|(mime, _)| offered.contains(mime)).copied()
}

/// A command's standard output when it succeeds. Its stderr is dropped.
fn run(argv: &[&str]) -> Option<Vec<u8>> {
    let (program, args) = argv.split_first()?;
    let output = Command::new(program).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(output.stdout)
}

/// Writes the bytes to a new file in `directory` and returns its path.
fn save(directory: &Path, bytes: &[u8], extension: &str) -> Option<PathBuf> {
    std::fs::create_dir_all(directory).ok()?;
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis();
    let path = directory.join(format!("paste-{millis}.{extension}"));
    std::fs::write(&path, bytes).ok()?;
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_is_taken_before_jpeg_and_other_types_are_ignored() {
        assert_eq!(pick_type("text/plain\nimage/jpeg\nimage/png\n"), Some(("image/png", "png")));
        assert_eq!(pick_type("text/plain\nimage/jpeg"), Some(("image/jpeg", "jpg")));
        assert_eq!(pick_type("text/plain\nimage/svg+xml"), None);
    }
}
