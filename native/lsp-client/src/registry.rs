//! Which server runs for which file, where it is installed, and which directory is its
//! workspace. Grove installs the servers it can into its own tools directory, which comes first;
//! then come Mason's directories (Grove's nvim profile installs servers through Mason), the places
//! tools are usually installed, and `PATH`. Extensions can add servers of their own while the app runs.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

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
    /// Whole file names, such as `Dockerfile`, that have no extension to go by.
    pub file_names: &'static [&'static str],
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

static TAPLO: Server = Server {
    name: "taplo",
    candidates: &[Candidate { program: "taplo", args: &["lsp", "stdio"] }],
    root_markers: &["taplo.toml", ".taplo.toml", ".git"],
};

static YAML: Server = Server {
    name: "yaml",
    candidates: &[Candidate { program: "yaml-language-server", args: &["--stdio"] }],
    root_markers: &[".git"],
};

static CLANGD: Server = Server {
    name: "clangd",
    candidates: &[Candidate { program: "clangd", args: &[] }],
    root_markers: &["compile_commands.json", "compile_flags.txt", ".clangd", ".git"],
};

static DOCKERFILE: Server = Server {
    name: "dockerfile",
    candidates: &[Candidate { program: "docker-langserver", args: &["--stdio"] }],
    root_markers: &[".git"],
};

static SQLS: Server = Server {
    name: "sqls",
    candidates: &[Candidate { program: "sqls", args: &[] }],
    root_markers: &[".sqls.yml", ".git"],
};

static SURREALQL: Server = Server {
    name: "surrealql",
    candidates: &[Candidate { program: "surrealql-language-server", args: &["--stdio"] }],
    root_markers: &[".git"],
};

static FILE_KINDS: [FileKind; 18] = [
    FileKind { extensions: &["rs"], file_names: &[], language_id: "rust", server: &RUST_ANALYZER },
    FileKind { extensions: &["ts", "mts", "cts"], file_names: &[], language_id: "typescript", server: &TYPESCRIPT },
    FileKind { extensions: &["tsx"], file_names: &[], language_id: "typescriptreact", server: &TYPESCRIPT },
    FileKind { extensions: &["js", "mjs", "cjs"], file_names: &[], language_id: "javascript", server: &TYPESCRIPT },
    FileKind { extensions: &["jsx"], file_names: &[], language_id: "javascriptreact", server: &TYPESCRIPT },
    FileKind { extensions: &["go"], file_names: &[], language_id: "go", server: &GOPLS },
    FileKind { extensions: &["py", "pyi"], file_names: &[], language_id: "python", server: &PYRIGHT },
    FileKind { extensions: &["lua"], file_names: &[], language_id: "lua", server: &LUA },
    FileKind { extensions: &["json", "jsonc"], file_names: &[], language_id: "json", server: &JSON },
    FileKind { extensions: &["css"], file_names: &[], language_id: "css", server: &CSS },
    FileKind { extensions: &["svelte"], file_names: &[], language_id: "svelte", server: &SVELTE },
    FileKind { extensions: &["toml"], file_names: &[], language_id: "toml", server: &TAPLO },
    FileKind { extensions: &["yaml", "yml"], file_names: &[], language_id: "yaml", server: &YAML },
    FileKind { extensions: &["c", "h"], file_names: &[], language_id: "c", server: &CLANGD },
    FileKind { extensions: &["cc", "cpp", "cxx", "hh", "hpp", "hxx"], file_names: &[], language_id: "cpp", server: &CLANGD },
    FileKind {
        extensions: &["dockerfile"],
        file_names: &["Dockerfile", "Containerfile"],
        language_id: "dockerfile",
        server: &DOCKERFILE,
    },
    FileKind { extensions: &["sql"], file_names: &[], language_id: "sql", server: &SQLS },
    FileKind { extensions: &["surql", "surrealql"], file_names: &[], language_id: "surrealql", server: &SURREALQL },
];

/// Every language server the app has built in, once each.
pub fn builtin_servers() -> Vec<&'static Server> {
    let mut servers: Vec<&'static Server> = Vec::new();
    for kind in FILE_KINDS.iter() {
        if !servers.iter().any(|known| known.name == kind.server.name) {
            servers.push(kind.server);
        }
    }
    servers
}

/// What an extension says about a language server of its own. A server the app already has for a
/// kind of file keeps it; an extension's server serves the files nothing else does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerDefinition {
    /// The name the status bar shows, and what a workspace has at most one of.
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub language_id: String,
    pub extensions: Vec<String>,
    pub file_names: Vec<String>,
    pub root_markers: Vec<String>,
}

/// The kinds of file extensions have servers for. Each is leaked once, so the rest of the host can
/// treat it as it does the built-in ones; a definition that does not change is not leaked again.
static EXTENSION_KINDS: RwLock<Vec<(ServerDefinition, &'static FileKind)>> = RwLock::new(Vec::new());

/// Replaces the servers extensions contribute with these.
pub fn set_extension_servers(definitions: Vec<ServerDefinition>) {
    let mut kinds = EXTENSION_KINDS.write().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut next = Vec::with_capacity(definitions.len());
    for definition in definitions {
        let existing = kinds.iter().find(|(known, _)| *known == definition).map(|(_, kind)| *kind);
        let kind = existing.unwrap_or_else(|| leak_kind(&definition));
        next.push((definition, kind));
    }
    *kinds = next;
}

/// A kind of file for a definition, with everything it names made to last as long as the program.
fn leak_kind(definition: &ServerDefinition) -> &'static FileKind {
    let args: Vec<&'static str> = definition.args.iter().map(|arg| leak_str(arg)).collect();
    let candidate = Candidate { program: leak_str(&definition.command), args: Box::leak(args.into_boxed_slice()) };
    let server = Server {
        name: leak_str(&definition.name),
        candidates: Box::leak(Box::new([candidate])),
        root_markers: leak_list(&definition.root_markers),
    };
    Box::leak(Box::new(FileKind {
        extensions: leak_list(&definition.extensions),
        file_names: leak_list(&definition.file_names),
        language_id: leak_str(&definition.language_id),
        server: Box::leak(Box::new(server)),
    }))
}

/// A string that lives for the rest of the program.
fn leak_str(text: &str) -> &'static str {
    Box::leak(text.to_string().into_boxed_str())
}

/// A list of strings that lives for the rest of the program.
fn leak_list(items: &[String]) -> &'static [&'static str] {
    let leaked: Vec<&'static str> = items.iter().map(|item| leak_str(item)).collect();
    Box::leak(leaked.into_boxed_slice())
}

/// The kind of file a path is, if some server serves it: a built-in one first, then an extension's.
pub fn file_kind(path: &Path) -> Option<&'static FileKind> {
    if let Some(kind) = FILE_KINDS.iter().find(|kind| serves(kind, path)) {
        return Some(kind);
    }
    let kinds = EXTENSION_KINDS.read().unwrap_or_else(|poisoned| poisoned.into_inner());
    kinds.iter().map(|(_, kind)| *kind).find(|kind| serves(kind, path))
}

/// Whether a kind of file covers a path, by its whole name or by its extension.
fn serves(kind: &FileKind, path: &Path) -> bool {
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    if kind.file_names.contains(&name.as_str()) {
        return true;
    }
    let Some(extension) = path.extension() else {
        return false;
    };
    let extension = extension.to_string_lossy().to_ascii_lowercase();
    kind.extensions.contains(&extension.as_str())
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
    search_directories_with(&[])
}

/// Like `search_directories`, with these directories, Grove's own tools directory among them,
/// ahead of everything but the explicit `GROVE_LSP_PATH`.
pub fn search_directories_with(first: &[PathBuf]) -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = Vec::new();
    if let Ok(extra) = std::env::var("GROVE_LSP_PATH") {
        directories.extend(std::env::split_paths(&extra));
    }
    directories.extend(first.iter().cloned());
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
    fn toml_yaml_c_dockerfile_sql_and_surrealql_files_have_servers() {
        let server = |path: &str| file_kind(Path::new(path)).map(|kind| (kind.language_id, kind.server.name));
        assert_eq!(server("/a/Cargo.toml"), Some(("toml", "taplo")));
        assert_eq!(server("/a/ci.yml"), Some(("yaml", "yaml")));
        assert_eq!(server("/a/main.c"), Some(("c", "clangd")));
        assert_eq!(server("/a/main.CPP"), Some(("cpp", "clangd")));
        assert_eq!(server("/a/query.sql"), Some(("sql", "sqls")));
        assert_eq!(server("/a/schema.surql"), Some(("surrealql", "surrealql")));
    }

    #[test]
    fn a_file_with_no_extension_is_served_by_its_whole_name() {
        let server = |path: &str| file_kind(Path::new(path)).map(|kind| kind.server.name);
        assert_eq!(server("/a/Dockerfile"), Some("dockerfile"));
        assert_eq!(server("/a/Containerfile"), Some("dockerfile"));
        assert_eq!(server("/a/prod.dockerfile"), Some("dockerfile"));
        assert_eq!(server("/a/dockerfile-notes"), None);
        assert_eq!(server("/a/Makefile"), None);
    }

    fn definition(name: &str, extension: &str) -> ServerDefinition {
        ServerDefinition {
            name: name.to_string(),
            command: format!("{name}-ls"),
            args: vec!["--stdio".to_string()],
            language_id: name.to_string(),
            extensions: vec![extension.to_string()],
            file_names: vec![],
            root_markers: vec![".git".to_string()],
        }
    }

    #[test]
    fn extension_servers_serve_what_no_built_in_does_and_can_be_replaced() {
        // The one test that sets them, since they are shared by every test in the process.
        set_extension_servers(vec![definition("zig", "zig"), definition("toml-fake", "toml")]);
        let kind = file_kind(Path::new("/a/main.zig")).unwrap();
        assert_eq!((kind.language_id, kind.server.name), ("zig", "zig"));
        assert_eq!(kind.server.candidates[0].program, "zig-ls");
        assert_eq!(kind.server.candidates[0].args, &["--stdio"]);
        // A built-in server keeps its files.
        assert_eq!(file_kind(Path::new("/a/Cargo.toml")).unwrap().server.name, "taplo");
        // The same definition is the same kind, so changing nothing leaks nothing.
        let again = file_kind(Path::new("/a/main.zig")).unwrap();
        set_extension_servers(vec![definition("zig", "zig")]);
        assert!(std::ptr::eq(again, file_kind(Path::new("/a/main.zig")).unwrap()));
        set_extension_servers(vec![]);
        assert!(file_kind(Path::new("/a/main.zig")).is_none());
    }

    #[test]
    fn the_tools_directory_comes_before_mason_and_the_path() {
        let tools = PathBuf::from("/grove/tools/bin");
        let directories = search_directories_with(std::slice::from_ref(&tools));
        let position = |wanted: &Path| directories.iter().position(|directory| directory == wanted);
        assert!(position(&tools).unwrap() <= 1, "{directories:?}");
        if let Some(mason) = std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share/nvim/mason/bin")) {
            assert!(position(&tools) < position(&mason));
        }
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
