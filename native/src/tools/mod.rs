//! The tool installer: Grove installs the language servers and tools it needs itself, as Mason
//! does, into its own directory under the data directory, without root.
//!
//! ```text
//! <data>/tools/bin/<executable>        links to what the tools provide; first on the server lookup path
//! <data>/tools/packages/<tool>/...     what each tool installed
//! ```
//!
//! A tool is a recipe (`recipe.rs`): a GitHub release asset picked by platform and architecture,
//! an npm or bun package into a private prefix, a pip package into a virtual environment, a
//! crate built with `cargo install --root`, or a Go program built with `go install`. Grove's own
//! recipes are in `catalog.json`, and extensions bring more through `tools_register`.
//!
//! Commands:
//!
//! - `tools_list` answers every tool as `{ id, name, description, source, binaries, installed,
//!   installing, unsupported }`, `unsupported` being why it cannot be installed here, or null.
//! - `tools_install { id }` installs a tool and answers once it is done, however long that takes,
//!   with `{ id, binaries }`. While it runs it emits `tool-progress { id, phase, message }`, `phase`
//!   being `started`, `output`, `finished` or `failed`.
//! - `tools_remove { id }` takes a tool away.
//! - `tools_register { tools: [{ id, name, description, install }] }` replaces the tools extensions bring.
//!
//! The language servers ask `Tools::tool_providing` which tool installs the server they did not find.

mod archive;
mod install;
mod recipe;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands, Emitter};

use install::{Installer, Internet, Network};
pub use recipe::Tool;

/// Grove's own recipes.
const CATALOG: &str = include_str!("catalog.json");

/// The tools directory under the data directory.
pub fn tools_directory() -> PathBuf {
    crate::data::data_directory().join("tools")
}

/// The directory executables are linked into, which goes first on the language server lookup path.
pub fn bin_directory() -> PathBuf {
    tools_directory().join("bin")
}

/// Everything the host knows about installable tools. Cheap to clone.
#[derive(Clone)]
pub struct Tools {
    inner: Arc<Inner>,
}

struct Inner {
    root: PathBuf,
    builtin: Vec<Tool>,
    from_extensions: Mutex<Vec<Tool>>,
    /// The ids of the tools being installed, so one is never installed twice at once.
    installing: Mutex<HashSet<String>>,
    network: Box<dyn Network>,
    emitter: Emitter,
}

impl Tools {
    /// The tools of this machine, installed under the data directory.
    pub fn new(emitter: Emitter) -> Tools {
        Tools::with(tools_directory(), Box::new(Internet), emitter)
    }

    /// Like `new`, with another directory and another way of reaching the network.
    fn with(root: PathBuf, network: Box<dyn Network>, emitter: Emitter) -> Tools {
        let builtin: Vec<Tool> = serde_json::from_str(CATALOG).expect("catalog.json holds tools");
        let inner = Inner { root, builtin, from_extensions: Mutex::new(Vec::new()), installing: Mutex::new(HashSet::new()), network, emitter };
        Tools { inner: Arc::new(inner) }
    }

    /// Registers the commands the UI lists, installs and removes tools with.
    pub fn register(&self, commands: Commands) -> Commands {
        let lister = self.clone();
        let installer = self.clone();
        let remover = self.clone();
        let registrar = self.clone();
        commands
            .command("tools_list", move |_| Ok::<_, CommandError>(lister.list()))
            .command("tools_install", move |args| {
                let id = tool_id(&args)?;
                installer.install(&id).map_err(|message| CommandError::with_code("InstallFailed", message))
            })
            .command("tools_remove", move |args| {
                let id = tool_id(&args)?;
                remover.remove(&id).map_err(|message| CommandError::with_code("RemoveFailed", message))
            })
            .command("tools_register", move |args| {
                registrar.register_extension_tools(&args).map_err(|message| CommandError::with_code("InvalidArguments", message))
            })
    }

    /// Every tool, Grove's own first, with whether it is installed.
    pub fn list(&self) -> Value {
        let installer = self.installer(&|_| {});
        let installing = lock(&self.inner.installing).clone();
        let tools: Vec<Value> = self
            .all()
            .iter()
            .map(|tool| {
                json!({
                    "id": tool.id,
                    "name": tool.name,
                    "description": tool.description,
                    "source": tool.source,
                    "binaries": tool.install.binaries(),
                    "installed": installer.is_installed(tool),
                    "installing": installing.contains(&tool.id),
                    "unsupported": installer.unsupported(tool),
                })
            })
            .collect();
        Value::Array(tools)
    }

    /// The tool that provides any of these executables, which is how a server that was not found is matched to its install.
    pub fn tool_providing(&self, programs: &[&str]) -> Option<String> {
        self.all()
            .into_iter()
            .find(|tool| tool.install.binaries().iter().any(|binary| programs.contains(&binary.as_str())))
            .map(|tool| tool.id)
    }

    /// Installs a tool, announcing each step, and answers with the executables it provides.
    pub fn install(&self, id: &str) -> Result<Value, String> {
        let tool = self.find(id).ok_or_else(|| format!("there is no tool called \"{id}\""))?;
        if !lock(&self.inner.installing).insert(tool.id.clone()) {
            return Err(format!("{} is already being installed", tool.name));
        }
        self.announce(&tool.id, "started", &format!("Installing {}", tool.name));
        let progress = |message: &str| self.announce(&tool.id, "output", message);
        let result = self.installer(&progress).install(&tool);
        lock(&self.inner.installing).remove(&tool.id);
        match result {
            Ok(binaries) => {
                self.announce(&tool.id, "finished", &format!("Installed {}", tool.name));
                Ok(json!({ "id": tool.id, "binaries": binaries }))
            }
            Err(message) => {
                self.announce(&tool.id, "failed", &message);
                Err(message)
            }
        }
    }

    /// Takes a tool away.
    pub fn remove(&self, id: &str) -> Result<Value, String> {
        let tool = self.find(id).ok_or_else(|| format!("there is no tool called \"{id}\""))?;
        self.installer(&|_| {}).remove(&tool)?;
        Ok(Value::Null)
    }

    /// Replaces the tools that extensions bring with the ones in `args.tools`.
    fn register_extension_tools(&self, args: &Value) -> Result<Value, String> {
        let given = args.get("tools").cloned().unwrap_or_else(|| json!([]));
        let tools: Vec<Tool> = serde_json::from_value(given).map_err(|error| format!("tools_register takes tools ({error})"))?;
        *lock(&self.inner.from_extensions) = tools;
        Ok(Value::Null)
    }

    /// Grove's tools and the extensions'.
    fn all(&self) -> Vec<Tool> {
        let mut tools = self.inner.builtin.clone();
        tools.extend(lock(&self.inner.from_extensions).iter().cloned());
        tools
    }

    /// A tool by id.
    fn find(&self, id: &str) -> Option<Tool> {
        self.all().into_iter().find(|tool| tool.id == id)
    }

    /// An installer that reports to `progress`.
    fn installer<'a>(&'a self, progress: &'a dyn Fn(&str)) -> Installer<'a> {
        Installer::new(&self.inner.root, self.inner.network.as_ref(), progress)
    }

    /// Tells the UI how an install is going.
    fn announce(&self, id: &str, phase: &str, message: &str) {
        self.inner.emitter.emit("tool-progress", json!({ "id": id, "phase": phase, "message": message }));
    }
}

/// The `id` of a command's arguments.
fn tool_id(args: &Value) -> Result<String, CommandError> {
    match args.get("id").and_then(Value::as_str) {
        Some(id) => Ok(id.to_string()),
        None => Err(CommandError::with_code("InvalidArguments", "this command takes a tool id")),
    }
}

/// Locks, carrying on after a thread that held the lock panicked.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests;
