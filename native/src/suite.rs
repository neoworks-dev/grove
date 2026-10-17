//! The suite daemon, as the native app needs it: where it listens, and a way to start it.
//!
//! Agents run in the neoworks-harness suite's daemon, and the UI talks to it over a WebSocket
//! with the suite's own TypeScript client, so the host only does what the UI cannot:
//!
//! - `suite_address` reads `daemon.json` next to the daemon's socket, which holds the loopback
//!   URL and token of the running daemon. It is read fresh on every call, since both change when
//!   the daemon restarts. It fails with the code `NotRunning` when there is no daemon.
//! - `suite_up` runs `suite up`, which starts the daemon in the background if it is not running,
//!   the same way `suite gui` does.
//!
//! `GROVE_SUITE` names the `suite` executable. Without it, `$SUITE_ROOT/bin/suite` is used, then
//! a `neoworks-harness` checkout next to this one (as the build assumes for its TypeScript
//! client), then `suite` on `PATH`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands};

/// Registers the commands the UI's agents plugin calls.
pub fn register(commands: Commands) -> Commands {
    commands
        .command("suite_address", |_| address(&info_path(), process_is_alive))
        .command("suite_up", |_| start_daemon())
}

/// The daemon's Unix socket: `$SUITE_SOCKET`, else `$XDG_RUNTIME_DIR/suite/bus.sock`, else
/// `/tmp/suite-<uid>/bus.sock`. The daemon and the suite's clients resolve it the same way.
fn socket_path(getenv: impl Fn(&str) -> Option<String>, uid: u32) -> PathBuf {
    let set = |name: &str| getenv(name).filter(|value| !value.is_empty());
    if let Some(socket) = set("SUITE_SOCKET") {
        return socket.into();
    }
    if let Some(directory) = set("XDG_RUNTIME_DIR") {
        return PathBuf::from(directory).join("suite").join("bus.sock");
    }
    PathBuf::from(format!("/tmp/suite-{uid}")).join("bus.sock")
}

/// The effective user id. std has no `getuid`; on Linux the owner of `/proc/self` is this
/// process's user, and the home directory is the next best thing elsewhere.
fn current_uid() -> u32 {
    use std::os::unix::fs::MetadataExt;
    let home = std::env::var("HOME").unwrap_or_default();
    [PathBuf::from("/proc/self"), PathBuf::from(home)]
        .iter()
        .find_map(|path| std::fs::metadata(path).ok())
        .map_or(0, |metadata| metadata.uid())
}

/// `daemon.json` sits next to the daemon's socket.
fn info_path() -> PathBuf {
    let socket = socket_path(|name| std::env::var(name).ok(), current_uid());
    socket.with_file_name("daemon.json")
}

/// Whether a process with this id exists, so a `daemon.json` left behind by a crashed daemon is
/// not taken for a running one. Where `/proc` is missing, the daemon is assumed to be alive.
fn process_is_alive(process_id: u64) -> bool {
    if !Path::new("/proc/self").exists() {
        return true;
    }
    Path::new(&format!("/proc/{process_id}")).exists()
}

/// The daemon's loopback URL and token from its info file, or `NotRunning` when there is no
/// file or its process is gone.
fn address(path: &Path, is_alive: impl Fn(u64) -> bool) -> Result<Value, CommandError> {
    let not_running =
        || CommandError::with_code("NotRunning", format!("the suite daemon is not running (no {})", path.display()));
    let raw = std::fs::read_to_string(path).map_err(|_| not_running())?;
    let not_an_info_file = || format!("{} is not a daemon info file", path.display());
    let info: Value = serde_json::from_str(&raw).map_err(|_| not_an_info_file())?;
    let (Some(url), Some(token)) = (info["url"].as_str(), info["token"].as_str()) else {
        return Err(not_an_info_file().into());
    };
    if let Some(process_id) = info["pid"].as_u64() {
        if !is_alive(process_id) {
            return Err(not_running());
        }
    }
    Ok(json!({ "url": url, "token": token }))
}

/// Where the `suite` executable is: the places listed in the module docs, first match wins.
fn find_suite(
    getenv: impl Fn(&str) -> Option<String>,
    exists: impl Fn(&Path) -> bool,
    manifest_directory: &Path,
) -> PathBuf {
    let set = |name: &str| getenv(name).filter(|value| !value.is_empty());
    if let Some(explicit) = set("GROVE_SUITE") {
        return explicit.into();
    }
    if let Some(root) = set("SUITE_ROOT") {
        return PathBuf::from(root).join("bin").join("suite");
    }
    for ancestor in manifest_directory.ancestors() {
        let sibling = ancestor.join("neoworks-harness").join("bin").join("suite");
        if exists(&sibling) {
            return sibling;
        }
    }
    PathBuf::from("suite")
}

/// Starts the daemon with `suite up`, waiting until it answers. Fails with the code `SuiteMissing`
/// when there is no `suite` to run and `StartFailed`, carrying what `suite` said, when it fails.
fn start_daemon() -> Result<Value, CommandError> {
    let executable =
        find_suite(|name| std::env::var(name).ok(), |path| path.exists(), Path::new(env!("CARGO_MANIFEST_DIR")));
    let output = Command::new(&executable).arg("up").output().map_err(|error| {
        CommandError::with_code("SuiteMissing", format!("could not run {}: {error}", executable.display()))
    })?;
    let said = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return Ok(json!(said));
    }
    let complaint = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(CommandError::with_code("StartFailed", complaint))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An environment lookup over a fixed list of pairs.
    fn environment<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        |name| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| value.to_string())
    }

    /// A directory of its own under the system temp directory, for a test's files.
    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("grove-suite-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn socket_path_prefers_the_explicit_socket_then_the_runtime_directory() {
        let both = [("SUITE_SOCKET", "/a/b.sock"), ("XDG_RUNTIME_DIR", "/run/u")];
        assert_eq!(socket_path(environment(&both), 7), PathBuf::from("/a/b.sock"));
        let runtime = [("XDG_RUNTIME_DIR", "/run/u")];
        assert_eq!(socket_path(environment(&runtime), 7), PathBuf::from("/run/u/suite/bus.sock"));
        assert_eq!(socket_path(environment(&[]), 7), PathBuf::from("/tmp/suite-7/bus.sock"));
    }

    #[test]
    fn reads_the_address_from_daemon_json() {
        let directory = scratch("address");
        let path = directory.join("daemon.json");
        std::fs::write(&path, r#"{"url":"http://127.0.0.1:4000","token":"t","pid":1}"#).unwrap();
        assert_eq!(address(&path, |_| true).unwrap(), json!({ "url": "http://127.0.0.1:4000", "token": "t" }));
        std::fs::write(&path, r#"{"url":1}"#).unwrap();
        assert!(address(&path, |_| true).is_err());
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_missing_daemon_json_means_not_running() {
        let error = address(Path::new("/nonexistent/daemon.json"), |_| true).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("NotRunning"));
    }

    #[test]
    fn a_daemon_json_of_a_dead_process_means_not_running() {
        let directory = scratch("dead");
        let path = directory.join("daemon.json");
        std::fs::write(&path, r#"{"url":"http://127.0.0.1:4000","token":"t","pid":99999999}"#).unwrap();
        let error = address(&path, |_| false).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("NotRunning"));
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn finds_suite_by_explicit_name_then_root_then_a_sibling_checkout() {
        let nowhere = |_: &Path| false;
        let explicit = [("GROVE_SUITE", "/x/suite"), ("SUITE_ROOT", "/y")];
        assert_eq!(
            find_suite(environment(&explicit), nowhere, Path::new("/w/grove/native")),
            PathBuf::from("/x/suite")
        );
        let root = [("SUITE_ROOT", "/y")];
        assert_eq!(
            find_suite(environment(&root), nowhere, Path::new("/w/grove/native")),
            PathBuf::from("/y/bin/suite")
        );
        let sibling_exists = |path: &Path| path == Path::new("/w/neoworks-harness/bin/suite");
        assert_eq!(
            find_suite(environment(&[]), sibling_exists, Path::new("/w/grove/.worktrees/457/native")),
            PathBuf::from("/w/neoworks-harness/bin/suite")
        );
        assert_eq!(find_suite(environment(&[]), nowhere, Path::new("/w/grove/native")), PathBuf::from("suite"));
    }
}
