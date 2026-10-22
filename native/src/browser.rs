//! Opening an address in the system's browser or mail app, for the links and buttons of a neoui
//! doc in the chat.
//!
//! - `open_url { url }` hands an `http`, `https` or `mailto` address to the system's opener
//!   (`xdg-open`, `open` or `explorer`) and returns at once. Anything else is refused, since the
//!   address comes from a document a model wrote.

use std::ffi::OsStr;
use std::process::{Command, Stdio};

use serde_json::Value;
use svelte_gpui::{CommandError, Commands};

/// Registers the browser commands.
pub fn register(commands: Commands) -> Commands {
    commands.command("open_url", |args| {
        open_url(args["url"].as_str().unwrap_or("")).map(|()| Value::Null)
    })
}

/// Opens a web or mail address with the system's opener.
fn open_url(url: &str) -> Result<(), CommandError> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    open_url_with(OsStr::new(program), url)
}

/// Opens the address with `program`, if it is a web or mail address without control characters.
fn open_url_with(program: &OsStr, url: &str) -> Result<(), CommandError> {
    if !is_openable(url) {
        return Err(format!("will not open {url}").into());
    }
    launch(program, url).map_err(Into::into)
}

/// Whether the address is `http`, `https` or `mailto`, on one line.
fn is_openable(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let allowed = ["http://", "https://", "mailto:"];
    allowed.iter().any(|scheme| lower.starts_with(scheme)) && !url.chars().any(char::is_control)
}

/// Starts `program` on the address and leaves it running: the window does not wait for it.
fn launch(program: &OsStr, url: &str) -> Result<(), String> {
    let mut child = Command::new(program)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", program.to_string_lossy()))?;
    // Reaped on a thread of its own, so an opener that stays attached leaves no zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_and_mail_addresses_are_openable() {
        for refused in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ssh://host",
            "/etc/passwd",
            "https://a.example/\nb",
            "",
        ] {
            assert!(!is_openable(refused), "{refused}");
        }
        for accepted in ["https://example.com/a?b=1", "HTTP://example.com", "mailto:a@b.c"] {
            assert!(is_openable(accepted), "{accepted}");
        }
    }

    #[test]
    fn a_refused_address_starts_nothing() {
        let missing = OsStr::new("/nonexistent-opener");
        let refused = open_url_with(missing, "file:///etc/passwd").unwrap_err();
        assert!(refused.message.contains("will not open"));
        // An allowed address reaches the opener, which here does not exist.
        let unstartable = open_url_with(missing, "https://example.com").unwrap_err();
        assert!(unstartable.message.contains("could not start"));
    }
}
