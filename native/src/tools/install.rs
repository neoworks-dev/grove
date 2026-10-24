//! Carrying a recipe out. Each tool gets a directory of its own under `packages/`, and the
//! executables it provides are linked into `bin/`, which is what goes first on the language
//! server lookup path. Nothing needs root: downloads and builds all happen under Grove's own
//! tools directory.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;

use serde_json::Value;

use super::archive;
use super::recipe::{Archive, Recipe, Tool, current_platform};

/// Where a release's files are read from, so tests need no network.
pub trait Network: Send + Sync {
    /// The JSON a URL answers.
    fn get_json(&self, url: &str) -> Result<Value, String>;
    /// Saves what a URL answers to `target`.
    fn download(&self, url: &str, target: &Path) -> Result<(), String>;
}

/// The real network, through `ureq`.
pub struct Internet;

impl Internet {
    /// A request with the headers GitHub asks of API users, and a token when the environment has one.
    fn request(&self, url: &str) -> ureq::Request {
        let mut request = ureq::get(url).set("User-Agent", "grove-native").set("Accept", "application/vnd.github+json");
        if url.starts_with("https://api.github.com/") {
            if let Ok(token) = std::env::var("GITHUB_TOKEN") {
                request = request.set("Authorization", &format!("Bearer {token}"));
            }
        }
        request
    }
}

impl Network for Internet {
    fn get_json(&self, url: &str) -> Result<Value, String> {
        let response = self.request(url).call().map_err(|error| describe_request_error(url, error))?;
        let text = response.into_string().map_err(|error| format!("could not read the answer of {url}: {error}"))?;
        serde_json::from_str(&text).map_err(|error| format!("the answer of {url} is not JSON ({error})"))
    }

    fn download(&self, url: &str, target: &Path) -> Result<(), String> {
        let response = ureq::get(url)
            .set("User-Agent", "grove-native")
            .call()
            .map_err(|error| describe_request_error(url, error))?;
        let mut file =
            std::fs::File::create(target).map_err(|error| format!("could not write {}: {error}", target.display()))?;
        std::io::copy(&mut response.into_reader(), &mut file).map(|_| ()).map_err(|error| format!("the download of {url} broke off ({error})"))
    }
}

/// A failed request as a sentence.
fn describe_request_error(url: &str, error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(403, _) if url.starts_with("https://api.github.com/") => {
            "GitHub is limiting requests from this address; try again later, or set GITHUB_TOKEN".to_string()
        }
        ureq::Error::Status(code, _) => format!("{url} answered {code}"),
        other => format!("could not reach {url} ({other})"),
    }
}

/// What an install needs: where tools go, what machine this is, and how to reach the network.
pub struct Installer<'a> {
    /// The tools directory, which holds `packages/` and `bin/`.
    pub root: &'a Path,
    pub platform: String,
    pub network: &'a dyn Network,
    /// The directories programs such as `npm` are looked for in, ahead of `PATH`.
    pub program_directories: Vec<PathBuf>,
    /// Told each step and each line a build prints.
    pub progress: &'a dyn Fn(&str),
}

impl<'a> Installer<'a> {
    /// An installer for this machine.
    pub fn new(root: &'a Path, network: &'a dyn Network, progress: &'a dyn Fn(&str)) -> Installer<'a> {
        Installer { root, platform: current_platform(), network, program_directories: usual_program_directories(), progress }
    }

    /// The directory the executables are linked into.
    pub fn bin_directory(&self) -> PathBuf {
        self.root.join("bin")
    }

    /// The directory a tool's files live in.
    pub fn package_directory(&self, tool: &Tool) -> PathBuf {
        self.root.join("packages").join(directory_name(&tool.id))
    }

    /// Installs a tool, replacing an earlier install of it, and returns the executables now on the lookup path.
    pub fn install(&self, tool: &Tool) -> Result<Vec<String>, String> {
        self.remove(tool)?;
        let package = self.package_directory(tool);
        std::fs::create_dir_all(&package).map_err(|error| format!("could not create {}: {error}", package.display()))?;
        let linked = self.run_recipe(tool, &package).and_then(|()| self.link_binaries(tool, &package));
        if linked.is_err() {
            let _ = std::fs::remove_dir_all(&package);
        }
        linked
    }

    /// Takes a tool away: its directory and the links to its executables.
    pub fn remove(&self, tool: &Tool) -> Result<(), String> {
        for binary in tool.install.binaries() {
            let link = self.bin_directory().join(binary);
            if std::fs::symlink_metadata(&link).is_ok() {
                std::fs::remove_file(&link).map_err(|error| format!("could not remove {}: {error}", link.display()))?;
            }
        }
        let package = self.package_directory(tool);
        if package.exists() {
            std::fs::remove_dir_all(&package).map_err(|error| format!("could not remove {}: {error}", package.display()))?;
        }
        Ok(())
    }

    /// Whether every executable of the tool is on the lookup path.
    pub fn is_installed(&self, tool: &Tool) -> bool {
        let binaries = tool.install.binaries();
        !binaries.is_empty() && binaries.iter().all(|binary| self.bin_directory().join(binary).exists())
    }

    /// Why a tool cannot be installed on this machine, or None when it can.
    pub fn unsupported(&self, tool: &Tool) -> Option<String> {
        match &tool.install {
            Recipe::GithubRelease { assets, .. } if !assets.contains_key(&self.platform) => {
                Some(format!("{} publishes nothing for {}", tool.name, self.platform))
            }
            Recipe::Npm { .. } if self.find_program("npm").is_none() && self.find_program("bun").is_none() => {
                Some("installing needs npm or bun, and neither is installed".to_string())
            }
            Recipe::Pip { .. } if self.find_program("python3").is_none() => Some("installing needs python3".to_string()),
            Recipe::Cargo { .. } if self.find_program("cargo").is_none() => Some("installing needs cargo".to_string()),
            Recipe::Go { .. } if self.find_program("go").is_none() => Some("installing needs the Go toolchain".to_string()),
            _ => None,
        }
    }

    /// Runs the part of the recipe that puts files in `package`.
    fn run_recipe(&self, tool: &Tool, package: &Path) -> Result<(), String> {
        match &tool.install {
            Recipe::GithubRelease { repo, tag, assets, archive, binaries } => {
                self.install_release(repo, tag.as_deref(), assets, *archive, binaries, package)
            }
            Recipe::Npm { package: name, version, .. } => self.install_npm(name, version.as_deref(), package),
            Recipe::Pip { package: name, version, .. } => self.install_pip(name, version.as_deref(), package),
            Recipe::Cargo { crate_name, version, .. } => self.install_cargo(crate_name, version.as_deref(), package),
            Recipe::Go { package: name, version, .. } => self.install_go(name, version.as_deref(), package),
        }
    }

    /// Downloads a release asset for this platform and unpacks it.
    fn install_release(
        &self,
        repo: &str,
        tag: Option<&str>,
        assets: &std::collections::BTreeMap<String, String>,
        archive: Archive,
        binaries: &[String],
        package: &Path,
    ) -> Result<(), String> {
        let template = assets.get(&self.platform).ok_or_else(|| format!("{repo} publishes nothing for {}", self.platform))?;
        (self.progress)(&format!("Looking up the {} release of {repo}", tag.unwrap_or("latest")));
        let release = self.network.get_json(&release_url(repo, tag))?;
        let release_tag = release.get("tag_name").and_then(Value::as_str).ok_or("the release has no tag")?;
        let asset = template.replace("{version}", release_tag.trim_start_matches('v')).replace("{tag}", release_tag);
        let url = asset_url(&release, &asset).ok_or_else(|| format!("release {release_tag} of {repo} has no file called {asset}"))?;
        let download = package.join(format!(".download-{asset}"));
        (self.progress)(&format!("Downloading {asset}"));
        self.network.download(&url, &download)?;
        (self.progress)(&format!("Unpacking {asset}"));
        let first = binaries.first().ok_or("the recipe names no executable")?;
        let result = archive::unpack(&download, archive.resolve(&asset), package, first);
        let _ = std::fs::remove_file(&download);
        result
    }

    /// Installs an npm package with npm, or bun when there is no npm.
    fn install_npm(&self, name: &str, version: Option<&str>, package: &Path) -> Result<(), String> {
        let spec = versioned(name, version, "@");
        if let Some(npm) = self.find_program("npm") {
            (self.progress)(&format!("Installing {spec} with npm"));
            let prefix = package.display().to_string();
            let arguments = ["install", "--prefix", prefix.as_str(), "--no-audit", "--no-fund", "--loglevel=error", spec.as_str()];
            return self.run(&npm, &arguments, package, &[]);
        }
        let bun = self.find_program("bun").ok_or("installing needs npm or bun, and neither is installed")?;
        (self.progress)(&format!("Installing {spec} with bun"));
        std::fs::write(package.join("package.json"), "{}\n").map_err(|error| format!("could not write package.json: {error}"))?;
        self.run(&bun, &["add", spec.as_str()], package, &[])
    }

    /// Installs a Python package into a virtual environment of its own.
    fn install_pip(&self, name: &str, version: Option<&str>, package: &Path) -> Result<(), String> {
        let python = self.find_program("python3").ok_or("installing needs python3")?;
        let venv = package.join("venv");
        (self.progress)("Creating a virtual environment");
        self.run(&python, &["-m", "venv", venv.display().to_string().as_str()], package, &[])?;
        let spec = versioned(name, version, "==");
        (self.progress)(&format!("Installing {spec} with pip"));
        self.run(&venv.join("bin/pip"), &["install", "--disable-pip-version-check", spec.as_str()], package, &[])
    }

    /// Builds a crate into the tool's own directory.
    fn install_cargo(&self, name: &str, version: Option<&str>, package: &Path) -> Result<(), String> {
        let cargo = self.find_program("cargo").ok_or("installing needs cargo")?;
        (self.progress)(&format!("Building {name} with cargo; this can take a few minutes"));
        let root = package.display().to_string();
        let mut arguments = vec!["install", "--locked", "--root", root.as_str()];
        if let Some(version) = version {
            arguments.extend(["--version", version]);
        }
        arguments.push(name);
        self.run(&cargo, &arguments, package, &[])
    }

    /// Builds a Go program into the tool's own `bin`.
    fn install_go(&self, name: &str, version: Option<&str>, package: &Path) -> Result<(), String> {
        let go = self.find_program("go").ok_or("installing needs the Go toolchain")?;
        let spec = format!("{name}@{}", version.unwrap_or("latest"));
        (self.progress)(&format!("Building {spec} with go"));
        let bin = package.join("bin").display().to_string();
        self.run(&go, &["install", spec.as_str()], package, &[("GOBIN", bin.as_str())])
    }

    /// Links each executable of the tool into `bin/`.
    fn link_binaries(&self, tool: &Tool, package: &Path) -> Result<Vec<String>, String> {
        let bin = self.bin_directory();
        std::fs::create_dir_all(&bin).map_err(|error| format!("could not create {}: {error}", bin.display()))?;
        let mut linked = Vec::new();
        for binary in tool.install.binaries() {
            let executable = locate_executable(&tool.install, package, binary)
                .ok_or_else(|| format!("the install finished but {binary} is not in it"))?;
            make_executable(&executable)?;
            let link = bin.join(binary);
            if std::fs::symlink_metadata(&link).is_ok() {
                let _ = std::fs::remove_file(&link);
            }
            std::os::unix::fs::symlink(&executable, &link)
                .map_err(|error| format!("could not link {}: {error}", link.display()))?;
            linked.push(binary.clone());
        }
        Ok(linked)
    }

    /// The first directory with a program of this name that can be run: the usual places, then `PATH`.
    pub fn find_program(&self, name: &str) -> Option<PathBuf> {
        let from_path = std::env::var_os("PATH").map(|path| std::env::split_paths(&path).collect::<Vec<_>>());
        let directories = self.program_directories.iter().cloned().chain(from_path.into_iter().flatten());
        for directory in directories {
            let candidate = directory.join(name);
            if is_runnable(&candidate) {
                return Some(candidate);
            }
        }
        None
    }

    /// Runs a program in `directory`, handing each line it prints to `progress`, and fails with the end of what it printed.
    fn run(&self, program: &Path, arguments: &[&str], directory: &Path, environment: &[(&str, &str)]) -> Result<(), String> {
        let mut command = Command::new(program);
        command.args(arguments).current_dir(directory).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        command.env("PATH", self.path_with_program_directories(program));
        for (name, value) in environment {
            command.env(name, value);
        }
        let mut child = command.spawn().map_err(|error| format!("could not run {}: {error}", program.display()))?;
        let (sender, receiver) = mpsc::channel::<String>();
        let readers: Vec<_> = [child.stdout.take().map(Source::Out), child.stderr.take().map(Source::Err)]
            .into_iter()
            .flatten()
            .map(|source| {
                let sender = sender.clone();
                std::thread::spawn(move || source.forward(sender))
            })
            .collect();
        drop(sender);
        let mut tail: Vec<String> = Vec::new();
        for line in receiver {
            (self.progress)(&line);
            tail.push(line);
            if tail.len() > 12 {
                tail.remove(0);
            }
        }
        for reader in readers {
            let _ = reader.join();
        }
        let status = child.wait().map_err(|error| format!("could not wait for {}: {error}", program.display()))?;
        if status.success() {
            return Ok(());
        }
        let name = program.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        Err(format!("{name} failed ({status}):\n{}", tail.join("\n")))
    }

    /// `PATH` for a child: the directory of the program that is run and the usual places first, so `npm` finds its `node`.
    fn path_with_program_directories(&self, program: &Path) -> std::ffi::OsString {
        let mut directories: Vec<PathBuf> = Vec::new();
        if let Some(parent) = program.parent() {
            directories.push(parent.to_path_buf());
        }
        directories.extend(self.program_directories.iter().cloned());
        if let Some(path) = std::env::var_os("PATH") {
            directories.extend(std::env::split_paths(&path));
        }
        std::env::join_paths(directories).unwrap_or_default()
    }
}

/// One of a child's output streams.
enum Source {
    Out(std::process::ChildStdout),
    Err(std::process::ChildStderr),
}

impl Source {
    /// Sends the stream's lines until it ends.
    fn forward(self, sender: mpsc::Sender<String>) {
        match self {
            Source::Out(stream) => send_lines(BufReader::new(stream), &sender),
            Source::Err(stream) => send_lines(BufReader::new(stream), &sender),
        }
    }
}

/// Sends each non-empty line of a reader.
fn send_lines(reader: impl BufRead, sender: &mpsc::Sender<String>) {
    for line in reader.lines().map_while(Result::ok) {
        let trimmed = line.trim_end().to_string();
        if !trimmed.is_empty() && sender.send(trimmed).is_err() {
            return;
        }
    }
}

/// Where a release is described: a tag's, or the latest.
fn release_url(repo: &str, tag: Option<&str>) -> String {
    match tag {
        Some(tag) => format!("https://api.github.com/repos/{repo}/releases/tags/{tag}"),
        None => format!("https://api.github.com/repos/{repo}/releases/latest"),
    }
}

/// The URL to download the release's file with this name from.
fn asset_url(release: &Value, name: &str) -> Option<String> {
    let assets = release.get("assets")?.as_array()?;
    let asset = assets.iter().find(|asset| asset.get("name").and_then(Value::as_str) == Some(name))?;
    asset.get("browser_download_url").and_then(Value::as_str).map(str::to_string)
}

/// A package name with a version after it, when there is one.
fn versioned(name: &str, version: Option<&str>, separator: &str) -> String {
    match version {
        Some(version) => format!("{name}{separator}{version}"),
        None => name.to_string(),
    }
}

/// A directory name for a tool id, which for an extension's tool has a colon and maybe a slash.
pub fn directory_name(id: &str) -> String {
    id.chars().map(|letter| if letter.is_ascii_alphanumeric() || letter == '-' || letter == '_' || letter == '.' { letter } else { '_' }).collect()
}

/// Where a tool's executable is once the recipe has run.
fn locate_executable(recipe: &Recipe, package: &Path, binary: &str) -> Option<PathBuf> {
    let known = match recipe {
        Recipe::GithubRelease { .. } => return find_file(package, binary),
        Recipe::Npm { .. } => package.join("node_modules/.bin").join(binary),
        Recipe::Pip { .. } => package.join("venv/bin").join(binary),
        Recipe::Cargo { .. } => package.join("bin").join(binary),
        Recipe::Go { .. } => package.join("bin").join(binary),
    };
    if known.exists() { Some(known) } else { None }
}

/// The shallowest file with this name under a directory.
fn find_file(directory: &Path, name: &str) -> Option<PathBuf> {
    let mut level = vec![directory.to_path_buf()];
    while !level.is_empty() {
        let mut next = Vec::new();
        for folder in level {
            let Ok(entries) = std::fs::read_dir(&folder) else {
                continue;
            };
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let path = entry.path();
                if path.is_dir() {
                    next.push(path);
                } else if entry.file_name() == name {
                    return Some(path);
                }
            }
        }
        level = next;
    }
    None
}

/// Makes a file runnable.
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = std::fs::metadata(path).map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(permissions.mode() | 0o755);
    std::fs::set_permissions(path, permissions).map_err(|error| format!("could not make {} runnable: {error}", path.display()))
}

/// Whether a path is a file that can be run.
fn is_runnable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(metadata) => metadata.is_file() && metadata.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

/// The places tools are usually installed, for a program started from a launcher with a short `PATH`.
fn usual_program_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        directories.extend([home.join(".cargo/bin"), home.join("go/bin"), home.join(".bun/bin"), home.join(".local/bin")]);
    }
    directories.extend(["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"].map(PathBuf::from));
    directories
}
