//! The terminal: shells in pseudo-terminals, emulated and drawn by the host, with no JavaScript in
//! the path of their output.
//!
//! This is how Zed does it. `alacritty_terminal` parses what a shell prints into a grid on a
//! thread of its own, and `TerminalElement` paints that grid with GPUI. The app's JavaScript only
//! says which terminals exist (a `session` prop on each view), and hears of titles, bells and
//! exits as events.
//!
//! A session outlives the views that show it, so closing a pane or hiding a tab does not kill the
//! shell; the app kills it with the `terminal_kill` command. A session is started the first time
//! a view that shows it has a size, so the shell starts with the right number of columns.
//!
//! Events, all with the session's `id`:
//!
//! - `terminal-title`, with the `title` to show on the tab.
//! - `terminal-bell`, when a program rang the bell.
//! - `terminal-exit`, with the exit `code`, when the shell ended.

mod element;
mod glyphs;
mod grid;
mod keys;
mod links;
mod mouse;
mod session;
mod theme;
mod view;

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands, Emitter};

use session::{CellPixels, GridSize, Session, SpawnOptions};
use theme::TerminalTheme;
use view::SessionSpec;
pub use view::TerminalView;

/// How often the process in front of each terminal is looked at, for tab titles.
const TITLE_SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

/// A terminal the registry knows of.
enum Slot {
    Running(Arc<Session>),
    /// Killed by the app; a view that still shows it does not start it again.
    Killed,
}

/// What the registry knows of a terminal id.
pub enum Lookup {
    Running(Arc<Session>),
    Killed,
    Unknown,
}

/// Every terminal session, by the id the app gave it. Cheap to clone.
#[derive(Clone)]
pub struct Terminals {
    slots: Arc<Mutex<HashMap<String, Slot>>>,
    emitter: Emitter,
}

impl Terminals {
    /// An empty registry whose terminals tell the app of their events through `emitter`. Starts the
    /// thread that keeps tab titles up to date.
    pub fn new(emitter: Emitter) -> Self {
        let terminals = Terminals { slots: Arc::new(Mutex::new(HashMap::new())), emitter };
        terminals.start_title_sampling();
        terminals
    }

    /// Adds the commands the app calls: `terminal_kill` and `terminal_cwd`.
    pub fn register(&self, commands: Commands) -> Commands {
        let for_kill = self.clone();
        let for_directory = self.clone();
        commands
            .command("terminal_kill", move |args| {
                let id = id_argument(&args)?;
                for_kill.kill(&id);
                Ok::<_, CommandError>(Value::Null)
            })
            .command("terminal_cwd", move |args| {
                let id = id_argument(&args)?;
                let directory = for_directory.working_directory(&id);
                Ok::<_, CommandError>(json!(directory))
            })
    }

    /// What is known of a terminal id.
    pub fn lookup(&self, id: &str) -> Lookup {
        match self.slots().get(id) {
            Some(Slot::Running(session)) => Lookup::Running(session.clone()),
            Some(Slot::Killed) => Lookup::Killed,
            None => Lookup::Unknown,
        }
    }

    /// The running session for a spec, starting its shell first if there is none yet. Gives none
    /// for a terminal the app has killed.
    fn start(
        &self,
        spec: &SessionSpec,
        grid: GridSize,
        cell: CellPixels,
        theme: &TerminalTheme,
    ) -> io::Result<Option<Arc<Session>>> {
        match self.lookup(&spec.id) {
            Lookup::Running(session) => return Ok(Some(session)),
            Lookup::Killed => return Ok(None),
            Lookup::Unknown => {}
        }
        let options = SpawnOptions { working_directory: start_directory(&spec.working_directory), command: None };
        let session = Session::spawn(&spec.id, options, grid, cell, theme.clone(), Some(self.emitter.clone()))?;
        self.slots().insert(spec.id.clone(), Slot::Running(session.clone()));
        Ok(Some(session))
    }

    /// Ends a terminal's shell and remembers that it was ended.
    fn kill(&self, id: &str) {
        let removed = self.slots().insert(id.to_string(), Slot::Killed);
        if let Some(Slot::Running(session)) = removed {
            session.shutdown();
        }
    }

    /// The directory a terminal's shell is in now.
    fn working_directory(&self, id: &str) -> Option<String> {
        let Lookup::Running(session) = self.lookup(id) else {
            return None;
        };
        let directory = session.working_directory()?;
        Some(directory.display().to_string())
    }

    /// The slots, locked. A panic while they were held does not lose them.
    fn slots(&self) -> MutexGuard<'_, HashMap<String, Slot>> {
        self.slots.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts a thread that looks at the process in front of each terminal, so a tab can be named
    /// after what runs in it.
    fn start_title_sampling(&self) {
        let terminals = self.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(TITLE_SAMPLE_INTERVAL);
                for session in terminals.running_sessions() {
                    session.sample_process();
                }
            }
        });
    }

    /// Every session whose shell is still running.
    fn running_sessions(&self) -> Vec<Arc<Session>> {
        let slots = self.slots();
        let running = slots.values().filter_map(|slot| match slot {
            Slot::Running(session) => Some(session.clone()),
            Slot::Killed => None,
        });
        running.collect()
    }
}

/// The `id` a command was called with.
fn id_argument(args: &Value) -> Result<String, CommandError> {
    match args.get("id").and_then(Value::as_str) {
        Some(id) => Ok(id.to_string()),
        None => Err(CommandError::with_code("InvalidArguments", "the command takes a terminal id")),
    }
}

/// The directory a shell starts in: the one asked for if it exists, else the home directory.
fn start_directory(requested: &str) -> PathBuf {
    let path = PathBuf::from(requested);
    if !requested.is_empty() && path.is_dir() {
        return path;
    }
    match std::env::var_os("HOME") {
        Some(home) => PathBuf::from(home),
        None => PathBuf::from("/"),
    }
}
