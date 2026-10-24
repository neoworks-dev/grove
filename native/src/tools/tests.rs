use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Mutex;

use flate2::Compression;
use flate2::write::GzEncoder;
use std::io::Write;

use super::install::{Installer, Network};
use super::recipe::{Archive, Recipe, Tool};
use super::*;

/// A fresh directory in the temp dir.
fn scratch(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("grove-tools-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    directory
}

/// A network with one release: the files it holds are what the downloads answer.
struct FakeNetwork {
    release: Value,
    files: BTreeMap<String, Vec<u8>>,
    asked: Mutex<Vec<String>>,
}

impl FakeNetwork {
    /// A release `tag` of a repository, holding these files.
    fn with(tag: &str, files: &[(&str, Vec<u8>)]) -> FakeNetwork {
        let assets: Vec<Value> = files
            .iter()
            .map(|(name, _)| json!({ "name": name, "browser_download_url": format!("https://downloads.test/{name}") }))
            .collect();
        FakeNetwork {
            release: json!({ "tag_name": tag, "assets": assets }),
            files: files.iter().map(|(name, bytes)| (format!("https://downloads.test/{name}"), bytes.clone())).collect(),
            asked: Mutex::new(Vec::new()),
        }
    }
}

impl Network for FakeNetwork {
    fn get_json(&self, url: &str) -> Result<Value, String> {
        self.asked.lock().unwrap().push(url.to_string());
        Ok(self.release.clone())
    }

    fn download(&self, url: &str, target: &Path) -> Result<(), String> {
        self.asked.lock().unwrap().push(url.to_string());
        let bytes = self.files.get(url).ok_or_else(|| format!("{url} answered 404"))?;
        std::fs::write(target, bytes).map_err(|error| error.to_string())
    }
}

/// Gzipped bytes.
fn gzipped(content: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(content).unwrap();
    encoder.finish().unwrap()
}

/// A gzipped tarball holding these files.
fn tarball(files: &[(&str, &str)]) -> Vec<u8> {
    let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
    for (path, content) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o644);
        header.set_entry_type(tar::EntryType::Regular);
        header.as_old_mut().name[..path.len()].copy_from_slice(path.as_bytes());
        header.set_cksum();
        builder.append(&header, content.as_bytes()).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

/// A release recipe with the same asset on every platform.
fn release_tool(id: &str, asset: &str, binaries: &[&str]) -> Tool {
    let platforms = ["linux-x64", "linux-arm64", "macos-x64", "macos-arm64"];
    Tool {
        id: id.to_string(),
        name: id.to_string(),
        description: String::new(),
        install: Recipe::GithubRelease {
            repo: "owner/name".to_string(),
            tag: None,
            assets: platforms.iter().map(|platform| (platform.to_string(), asset.to_string())).collect(),
            archive: Archive::Auto,
            binaries: binaries.iter().map(|binary| binary.to_string()).collect(),
        },
        source: String::new(),
    }
}

/// An installer over a scratch directory, with the programs looked for in `programs` only.
fn installer<'a>(root: &'a Path, network: &'a dyn Network, programs: Vec<PathBuf>, progress: &'a dyn Fn(&str)) -> Installer<'a> {
    let mut installer = Installer::new(root, network, progress);
    installer.program_directories = programs;
    installer
}

/// A program in `directory` that is a shell script with this body.
fn script(directory: &Path, name: &str, body: &str) {
    std::fs::create_dir_all(directory).unwrap();
    let path = directory.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn a_gzipped_release_binary_is_downloaded_unpacked_and_linked_first_on_the_path() {
    let root = scratch("gz");
    let network = FakeNetwork::with("0.10.0", &[("taplo-linux-x86_64.gz", gzipped(b"#!/bin/sh\necho taplo\n"))]);
    let tool = release_tool("taplo", "taplo-linux-x86_64.gz", &["taplo"]);
    let messages = Mutex::new(Vec::<String>::new());
    let progress = |message: &str| messages.lock().unwrap().push(message.to_string());
    let installer = installer(&root, &network, vec![], &progress);

    assert!(!installer.is_installed(&tool));
    let linked = installer.install(&tool).unwrap();

    assert_eq!(linked, ["taplo"]);
    assert!(installer.is_installed(&tool));
    let link = root.join("bin/taplo");
    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::metadata(&link).unwrap().permissions().mode() & 0o111, 0o111);
    assert_eq!(std::fs::read_to_string(&link).unwrap(), "#!/bin/sh\necho taplo\n");
    assert_eq!(network.asked.lock().unwrap()[0], "https://api.github.com/repos/owner/name/releases/latest");
    assert!(messages.lock().unwrap().iter().any(|message| message == "Downloading taplo-linux-x86_64.gz"));
    // Nothing is left over from the download.
    assert!(std::fs::read_dir(root.join("packages/taplo")).unwrap().all(|entry| !entry.unwrap().file_name().to_string_lossy().starts_with(".download")));
}

#[test]
fn the_version_in_an_asset_name_is_the_tag_without_its_v() {
    let root = scratch("version");
    let network = FakeNetwork::with("v0.2.48", &[("sqls-0.2.48.tar.gz", tarball(&[("sqls/bin/sqls", "run")]))]);
    let tool = release_tool("sqls", "sqls-{version}.tar.gz", &["sqls"]);
    let installer = installer(&root, &network, vec![], &|_| {});
    installer.install(&tool).unwrap();
    // The binary is found wherever the archive put it, and the rest of the archive stays beside it.
    assert_eq!(std::fs::read_to_string(root.join("bin/sqls")).unwrap(), "run");
    assert!(root.join("packages/sqls/sqls/bin/sqls").exists());
}

#[test]
fn a_release_without_the_asset_is_an_error_that_leaves_nothing_behind() {
    let root = scratch("missing-asset");
    let network = FakeNetwork::with("1.0.0", &[("other.gz", gzipped(b"x"))]);
    let tool = release_tool("taplo", "taplo-1.0.gz", &["taplo"]);
    let installer = installer(&root, &network, vec![], &|_| {});
    let message = installer.install(&tool).unwrap_err();
    assert!(message.contains("has no file called taplo-1.0.gz"), "{message}");
    assert!(!root.join("packages/taplo").exists());
    assert!(!root.join("bin/taplo").exists());
}

#[test]
fn a_platform_without_an_asset_is_unsupported_and_says_so() {
    let root = scratch("unsupported");
    let network = FakeNetwork::with("1.0.0", &[]);
    let mut tool = release_tool("clangd", "clangd.zip", &["clangd"]);
    if let Recipe::GithubRelease { assets, .. } = &mut tool.install {
        assets.clear();
        assets.insert("windows-x64".to_string(), "clangd-windows.zip".to_string());
    }
    let installer = installer(&root, &network, vec![], &|_| {});
    assert!(installer.unsupported(&tool).unwrap().contains("publishes nothing for"));
    assert!(installer.install(&tool).is_err());
}

#[test]
fn an_npm_package_is_installed_with_npm_into_a_private_prefix() {
    let root = scratch("npm");
    let programs = scratch("npm-programs");
    // A stand-in `npm` that makes what the real one would: a package with a bin link.
    script(
        &programs,
        "npm",
        r#"prefix="$3"; echo "added 1 package"; mkdir -p "$prefix/node_modules/.bin"; printf '#!/bin/sh\necho yaml\n' > "$prefix/node_modules/.bin/yaml-language-server"; chmod +x "$prefix/node_modules/.bin/yaml-language-server""#,
    );
    let network = FakeNetwork::with("1.0.0", &[]);
    let lines = Mutex::new(Vec::<String>::new());
    let progress = |message: &str| lines.lock().unwrap().push(message.to_string());
    let installer = installer(&root, &network, vec![programs], &progress);
    let tool = Tool {
        id: "yaml-language-server".to_string(),
        name: "YAML".to_string(),
        description: String::new(),
        install: Recipe::Npm { package: "yaml-language-server".to_string(), version: None, binaries: vec!["yaml-language-server".to_string()] },
        source: String::new(),
    };
    installer.install(&tool).unwrap();
    assert_eq!(std::fs::read_to_string(root.join("bin/yaml-language-server")).unwrap(), "#!/bin/sh\necho yaml\n");
    assert!(lines.lock().unwrap().iter().any(|line| line == "added 1 package"));
    assert!(root.join("packages/yaml-language-server/node_modules/.bin/yaml-language-server").exists());
}

#[test]
fn a_build_that_fails_reports_the_end_of_its_output_and_leaves_nothing_behind() {
    let root = scratch("cargo-fails");
    let programs = scratch("cargo-programs");
    script(&programs, "cargo", "echo 'compiling a'; echo 'error: could not compile' >&2; exit 101");
    let network = FakeNetwork::with("1.0.0", &[]);
    let installer = installer(&root, &network, vec![programs], &|_| {});
    let tool = Tool {
        id: "taplo-cli".to_string(),
        name: "taplo-cli".to_string(),
        description: String::new(),
        install: Recipe::Cargo { crate_name: "taplo-cli".to_string(), version: None, binaries: vec!["taplo".to_string()] },
        source: String::new(),
    };
    let message = installer.install(&tool).unwrap_err();
    assert!(message.contains("cargo failed"), "{message}");
    assert!(message.contains("error: could not compile"), "{message}");
    assert!(!root.join("packages/taplo-cli").exists());
}

#[test]
fn an_install_that_finishes_without_its_executable_is_a_failure() {
    let root = scratch("no-binary");
    let programs = scratch("go-programs");
    script(&programs, "go", r#"mkdir -p "$GOBIN"; echo built"#);
    let network = FakeNetwork::with("1.0.0", &[]);
    let installer = installer(&root, &network, vec![programs], &|_| {});
    let tool = Tool {
        id: "gopls".to_string(),
        name: "gopls".to_string(),
        description: String::new(),
        install: Recipe::Go { package: "golang.org/x/tools/gopls".to_string(), version: None, binaries: vec!["gopls".to_string()] },
        source: String::new(),
    };
    assert!(installer.install(&tool).unwrap_err().contains("gopls is not in it"));
}

#[test]
fn a_recipe_whose_program_is_missing_is_unsupported_before_anything_runs() {
    let root = scratch("no-programs");
    let network = FakeNetwork::with("1.0.0", &[]);
    let installer = installer(&root, &network, vec![scratch("empty-programs")], &|_| {});
    let catalog: Vec<Tool> = serde_json::from_str(CATALOG).unwrap();
    let gopls = catalog.iter().find(|tool| tool.id == "gopls").unwrap();
    // The scratch directory has no `go`, and neither the usual places nor `PATH` can be controlled here, so only check the shape.
    let reason = installer.unsupported(gopls);
    if installer.find_program("go").is_none() {
        assert_eq!(reason.as_deref(), Some("installing needs the Go toolchain"));
    } else {
        assert!(reason.is_none());
    }
}

#[test]
fn removing_a_tool_takes_its_files_and_links() {
    let root = scratch("remove");
    let network = FakeNetwork::with("1.0.0", &[("t.gz", gzipped(b"x"))]);
    let tool = release_tool("t", "t.gz", &["t"]);
    let installer = installer(&root, &network, vec![], &|_| {});
    installer.install(&tool).unwrap();
    assert!(installer.is_installed(&tool));
    installer.remove(&tool).unwrap();
    assert!(!installer.is_installed(&tool));
    assert!(!root.join("packages/t").exists());
    assert!(std::fs::symlink_metadata(root.join("bin/t")).is_err());
}

#[test]
fn reinstalling_replaces_the_files_of_the_earlier_install() {
    let root = scratch("reinstall");
    let first = FakeNetwork::with("1.0.0", &[("t.gz", gzipped(b"one"))]);
    let tool = release_tool("t", "t.gz", &["t"]);
    installer(&root, &first, vec![], &|_| {}).install(&tool).unwrap();
    let second = FakeNetwork::with("2.0.0", &[("t.gz", gzipped(b"two"))]);
    installer(&root, &second, vec![], &|_| {}).install(&tool).unwrap();
    assert_eq!(std::fs::read_to_string(root.join("bin/t")).unwrap(), "two");
}

#[test]
fn the_store_lists_tools_installs_them_and_announces_each_step() {
    let root = scratch("store");
    let network = FakeNetwork::with("1.0.0", &[("t.gz", gzipped(b"x"))]);
    let emitter = Emitter::default();
    let tools = Tools::with(root.clone(), Box::new(network), emitter);
    let registered = json!({ "tools": [{
        "id": "ext:t", "name": "T", "source": "ext",
        "install": { "kind": "github-release", "repo": "o/n", "binaries": ["t"],
                     "assets": { "linux-x64": "t.gz", "linux-arm64": "t.gz", "macos-x64": "t.gz", "macos-arm64": "t.gz" } }
    }] });
    tools.register_extension_tools(&registered).unwrap();

    let listed = tools.list();
    let entry = listed.as_array().unwrap().iter().find(|tool| tool["id"] == "ext:t").unwrap();
    assert_eq!((entry["installed"].as_bool(), entry["source"].as_str()), (Some(false), Some("ext")));

    let installed = tools.install("ext:t").unwrap();
    assert_eq!(installed, json!({ "id": "ext:t", "binaries": ["t"] }));
    assert!(root.join("bin/t").exists());
    let listed = tools.list();
    let entry = listed.as_array().unwrap().iter().find(|tool| tool["id"] == "ext:t").unwrap();
    assert_eq!(entry["installed"], json!(true));
    assert!(tools.install("nothing").unwrap_err().contains("no tool called"));
    assert_eq!(tools.tool_providing(&["t"]), Some("ext:t".to_string()));

    // Registering again replaces the extensions' tools.
    tools.register_extension_tools(&json!({ "tools": [] })).unwrap();
    assert!(tools.find("ext:t").is_none());
}

#[test]
fn grove_has_a_recipe_for_every_built_in_server_and_for_the_others_it_names() {
    let catalog: Vec<Tool> = serde_json::from_str(CATALOG).unwrap();
    let mut ids: Vec<&str> = catalog.iter().map(|tool| tool.id.as_str()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), catalog.len(), "tool ids are unique");
    for tool in &catalog {
        assert!(!tool.install.binaries().is_empty(), "{} names an executable", tool.id);
        if let Recipe::GithubRelease { assets, .. } = &tool.install {
            assert!(assets.contains_key("linux-x64") || assets.contains_key("macos-arm64"), "{} has an asset", tool.id);
        }
    }
    let tools = Tools::with(scratch("catalog"), Box::new(FakeNetwork::with("1", &[])), Emitter::default());
    let missing: Vec<&str> = lsp_client::registry::builtin_servers()
        .into_iter()
        .filter(|server| tools.tool_providing(&[server.candidates[0].program]).is_none())
        .map(|server| server.name)
        .collect();
    assert!(missing.is_empty(), "no recipe for {missing:?}");
    for wanted in ["taplo", "yaml-language-server", "clangd", "dockerfile-language-server", "sqls", "surrealql-language-server"] {
        assert!(ids.contains(&wanted), "{wanted} has a recipe");
    }
}
