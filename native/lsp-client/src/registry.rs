//! Which server runs for which file, where it is installed, and which directory is its
//! workspace. Grove's nvim profile installs servers through Mason, so Mason's directories come
//! first, then the places tools are usually installed, then `PATH`.

use std::path::{Path, PathBuf};

use crate::client::ServerCommand;

/// One way to start a server. A server may have several, tried in order.
pub struct Candidate {
    pub program: &'static str,
    pub args: &'static [&'static str],
}

/// A language server: how it is started and how its workspace is found.
pub struct Server {
    /// The name shown in the status bar, and what a workspace has at most one of.
    pub name: &'static str,
    pub candidates: &'static [Candidate],
    /// Files or directories that mark the root of a workspace. The nearest directory above a
    /// file that has one is the root.
    pub root_markers: &'static [&'static str],
}

/// Which language a kind of file is, and the server that serves it.
pub struct FileKind {
    pub extensions: &'static [&'static str],
    /// The language id sent in `didOpen`.
    pub language_id: &'static str,
    pub server: &'static Server,
}

static RUST_ANALYZER: Server = Server {
    name: "rust-analyzer",
    candidates: &[Candidate { program: "rust-analyzer", args: &[] }],
    root_markers: &["Cargo.toml"],
};

static TYPESCRIPT: Server = Server {
    name: "typescript",
    candidates: &[
        Candidate { program: "vtsls", args: &["--stdio"] },
        Candidate { program: "typescript-language-server", args: &["--stdio"] },
    ],
    root_markers: &["tsconfig.json", "jsconfig.json", "package.json"],
};

static GOPLS: Server = Server {
    name: "gopls",
    candidates: &[Candidate { program: "gopls", args: &[] }],
    root_markers: &["go.work", "go.mod"],
};

static PYRIGHT: Server = Server {
    name: "pyright",
    candidates: &[Candidate { program: "pyright-langserver", args: &["--stdio"] }],
    root_markers: &["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
};

static LUA: Server = Server {
    name: "lua-language-server",
    candidates: &[Candidate { program: "lua-language-server", args: &[] }],
    root_markers: &[".luarc.json", ".git"],
};

static JSON: Server = Server {
    name: "json",
    candidates: &[Candidate { program: "vscode-json-language-server", args: &["--stdio"] }],
    root_markers: &["package.json", ".git"],
};

static CSS: Server = Server {
    name: "css",
    candidates: &[Candidate { program: "vscode-css-language-server", args: &["--stdio"] }],
    root_markers: &["package.json", ".git"],
};

static SVELTE: Server = Server {
    name: "svelte",
    candidates: &[Candidate { program: "svelteserver", args: &["--stdio"] }],
    root_markers: &["package.json", ".git"],
};

static FILE_KINDS: [FileKind; 11] = [
    FileKind { extensions: &["rs"], language_id: "rust", server: &RUST_ANALYZER },
    FileKind { extensions: &["ts", "mts", "cts"], language_id: "typescript", server: &TYPESCRIPT },
    FileKind { extensions: &["tsx"], language_id: "typescriptreact", server: &TYPESCRIPT },
    FileKind { extensions: &["js", "mjs", "cjs"], language_id: "javascript", server: &TYPESCRIPT },
    FileKind { extensions: &["jsx"], language_id: "javascriptreact", server: &TYPESCRIPT },
    FileKind { extensions: &["go"], language_id: "go", server: &GOPLS },
    FileKind { extensions: &["py", "pyi"], language_id: "python", server: &PYRIGHT },
    FileKind { extensions: &["lua"], language_id: "lua", server: &LUA },
    FileKind { extensions: &["json", "jsonc"], language_id: "json", server: &JSON },
    FileKind { extensions: &["css"], language_id: "css", server: &CSS },
    FileKind { extensions: &["svelte"], language_id: "svelte", server: &SVELTE },
];

/// The kind of file a path is, if some server serves it.
pub fn file_kind(path: &Path) -> Option<&'static FileKind> {
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    FILE_KINDS.iter().find(|kind| kind.extensions.contains(&extension.as_str()))
}

/// The workspace a file belongs to: the nearest directory above it with one of the server's
/// markers. For Rust that is the outermost `Cargo.toml` that declares a workspace, so every
/// crate of a workspace shares one server. A file without any marker is its own directory's workspace.
pub fn workspace_root(file: &Path, server: &Server) -> PathBuf {
    let start = file.parent().unwrap_or(file);
    if server.name == RUST_ANALYZER.name {
        if let Some(root) = cargo_workspace_root(start) {
            return root;
        }
    }
    for directory in start.ancestors() {
        if server.root_markers.iter().any(|marker| directory.join(marker).exists()) {
            return directory.to_path_buf();
        }
    }
    start.to_path_buf()
}

/// The outermost directory above `start` whose `Cargo.toml` has a `[workspace]`, else the
/// nearest directory with a `Cargo.toml`.
fn cargo_workspace_root(start: &Path) -> Option<PathBuf> {
    let mut nearest: Option<PathBuf> = None;
    let mut outermost_workspace: Option<PathBuf> = None;
    for directory in start.ancestors() {
        let manifest = directory.join("Cargo.toml");
        let Ok(text) = std::fs::read_to_string(&manifest) else {
            continue;
        };
        if nearest.is_none() {
            nearest = Some(directory.to_path_buf());
        }
        if text.lines().any(|line| line.trim() == "[workspace]") {
            outermost_workspace = Some(directory.to_path_buf());
        }
    }
    outermost_workspace.or(nearest)
}

/// The directories servers are looked for in, most specific first.
pub fn search_directories() -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = Vec::new();
    if let Ok(extra) = std::env::var("GROVE_LSP_PATH") {
        directories.extend(std::env::split_paths(&extra));
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        directories.push(home.join(".config/grove/nvim-runtime/data/nvim/mason/bin"));
        directories.push(home.join(".local/share/nvim/mason/bin"));
        directories.push(home.join(".cargo/bin"));
        directories.push(home.join("go/bin"));
        directories.push(home.join(".bun/bin"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&path));
    }
    directories
}

/// The first of the server's candidates that is installed in one of `directories`.
pub fn command_for(server: &Server, directories: &[PathBuf]) -> Option<ServerCommand> {
    for candidate in server.candidates {
        let Some(program) = find_executable(candidate.program, directories) else {
            continue;
        };
        return Some(ServerCommand { program, args: candidate.args.iter().map(|arg| arg.to_string()).collect() });
    }
    None
}

/// The executable file called `name` in the first directory that has one.
pub fn find_executable(name: &str, directories: &[PathBuf]) -> Option<PathBuf> {
    directories.iter().map(|directory| directory.join(name)).find(|path| is_executable(path))
}

/// Whether a path is a file that can be run.
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(metadata) => metadata.is_file() && metadata.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A fresh directory in the temp dir.
    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("lsp-registry-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn files_are_served_by_their_extension() {
        let kind = file_kind(Path::new("/a/b/main.rs")).unwrap();
        assert_eq!((kind.language_id, kind.server.name), ("rust", "rust-analyzer"));
        assert_eq!(file_kind(Path::new("x.TSX")).unwrap().language_id, "typescriptreact");
        assert_eq!(file_kind(Path::new("x.mjs")).unwrap().server.name, "typescript");
        assert!(file_kind(Path::new("README.md")).is_none());
        assert!(file_kind(Path::new("Makefile")).is_none());
    }

    #[test]
    fn the_workspace_is_the_nearest_directory_with_a_marker() {
        let root = scratch("ts");
        std::fs::create_dir_all(root.join("packages/app/src")).unwrap();
        std::fs::write(root.join("package.json"), "{}").unwrap();
        std::fs::write(root.join("packages/app/tsconfig.json"), "{}").unwrap();
        let file = root.join("packages/app/src/index.ts");
        assert_eq!(workspace_root(&file, &TYPESCRIPT), root.join("packages/app"));
        assert_eq!(workspace_root(&root.join("other/file.ts"), &TYPESCRIPT), root);
        let lonely = scratch("lonely");
        assert_eq!(workspace_root(&lonely.join("a.go"), &GOPLS), lonely);
    }

    #[test]
    fn a_crate_in_a_cargo_workspace_belongs_to_the_workspace() {
        let root = scratch("cargo");
        std::fs::create_dir_all(root.join("member/src")).unwrap();
        std::fs::write(root.join("Cargo.toml"), "[workspace]\nmembers = [\"member\"]\n").unwrap();
        std::fs::write(root.join("member/Cargo.toml"), "[package]\nname = \"member\"\n").unwrap();
        assert_eq!(workspace_root(&root.join("member/src/lib.rs"), &RUST_ANALYZER), root);
        let single = scratch("cargo-single");
        std::fs::create_dir_all(single.join("src")).unwrap();
        std::fs::write(single.join("Cargo.toml"), "[package]\nname = \"one\"\n").unwrap();
        assert_eq!(workspace_root(&single.join("src/main.rs"), &RUST_ANALYZER), single);
    }

    #[test]
    fn the_first_installed_candidate_runs_the_server() {
        let first = scratch("bin-first");
        let second = scratch("bin-second");
        let runnable = |directory: &Path, name: &str| {
            let path = directory.join(name);
            std::fs::write(&path, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        std::fs::write(first.join("vtsls"), "not executable").unwrap();
        runnable(&second, "typescript-language-server");
        let directories = vec![first.clone(), second.clone()];
        let command = command_for(&TYPESCRIPT, &directories).unwrap();
        assert_eq!(command.program, second.join("typescript-language-server"));
        assert_eq!(command.args, vec!["--stdio"]);
        runnable(&first, "vtsls");
        assert_eq!(command_for(&TYPESCRIPT, &directories).unwrap().program, first.join("vtsls"));
        assert!(command_for(&GOPLS, &directories).is_none());
    }
}
