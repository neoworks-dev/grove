//! Where Grove keeps what it installs. The directory is the one the sidecar uses, so the
//! native app has a single data home: `GROVE_SIDECAR_DATA` when it is set, else `grove-native`
//! under `XDG_DATA_HOME`, else `~/.local/share/grove-native`. Setting the variable moves
//! everything at once, which is how tests keep installs out of a real profile.

use std::path::PathBuf;

use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands};

/// Registers `data_directory`, which answers the path as a string.
pub fn register(commands: Commands) -> Commands {
    commands.command("data_directory", |_| Ok::<Value, CommandError>(json!(data_directory().display().to_string())))
}

/// The data directory for this process's environment.
pub fn data_directory() -> PathBuf {
    directory_from(|name| std::env::var(name).ok())
}

/// The data directory for an environment, given as a lookup so tests need not touch the real one.
fn directory_from(getenv: impl Fn(&str) -> Option<String>) -> PathBuf {
    let set = |name: &str| getenv(name).filter(|value| !value.is_empty());
    if let Some(explicit) = set("GROVE_SIDECAR_DATA") {
        return explicit.into();
    }
    if let Some(data_home) = set("XDG_DATA_HOME") {
        return PathBuf::from(data_home).join("grove-native");
    }
    let home = set("HOME").unwrap_or_else(|| "/".to_string());
    PathBuf::from(home).join(".local/share/grove-native")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An environment of exactly these variables.
    fn environment<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| value.to_string())
    }

    #[test]
    fn the_explicit_directory_wins_over_the_xdg_data_home() {
        let both = [("GROVE_SIDECAR_DATA", "/tmp/grove"), ("XDG_DATA_HOME", "/xdg"), ("HOME", "/home/a")];
        assert_eq!(directory_from(environment(&both)), PathBuf::from("/tmp/grove"));
    }

    #[test]
    fn the_xdg_data_home_then_the_home_directory_give_the_default() {
        let xdg = [("XDG_DATA_HOME", "/xdg"), ("HOME", "/home/a")];
        assert_eq!(directory_from(environment(&xdg)), PathBuf::from("/xdg/grove-native"));
        let home = [("HOME", "/home/a"), ("XDG_DATA_HOME", "")];
        assert_eq!(directory_from(environment(&home)), PathBuf::from("/home/a/.local/share/grove-native"));
    }
}
