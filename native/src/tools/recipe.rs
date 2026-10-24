//! What a recipe is: how one tool is obtained without root. The shape is the one extensions
//! write in their manifests (`kernel/extensions/recipes.ts` validates it on the UI side), and
//! Grove's own recipes in `catalog.json` use it too.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// How a downloaded release asset holds the tool.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub enum Archive {
    /// Decided by the asset's file name: `.tar.gz`, `.tgz`, `.zip` or `.gz`, else a bare file.
    #[default]
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "none")]
    None,
    #[serde(rename = "gz")]
    Gz,
    #[serde(rename = "tar.gz")]
    TarGz,
    #[serde(rename = "zip")]
    Zip,
}

impl Archive {
    /// The kind an asset name says it is, when the recipe leaves it to the name.
    pub fn resolve(self, asset: &str) -> Archive {
        if self != Archive::Auto {
            return self;
        }
        let name = asset.to_ascii_lowercase();
        if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
            Archive::TarGz
        } else if name.ends_with(".zip") {
            Archive::Zip
        } else if name.ends_with(".gz") {
            Archive::Gz
        } else {
            Archive::None
        }
    }
}

/// A way to get a tool onto the machine.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Recipe {
    /// A file or archive from a GitHub release; `{version}` in an asset name is the tag without its `v`.
    GithubRelease {
        repo: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tag: Option<String>,
        /// The asset to download for each platform, as `<os>-<arch>`.
        assets: BTreeMap<String, String>,
        #[serde(default)]
        archive: Archive,
        binaries: Vec<String>,
    },
    /// A package installed with npm, or bun when there is no npm, into a prefix of its own.
    Npm {
        package: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        binaries: Vec<String>,
    },
    /// A package installed with pip into a virtual environment of its own.
    Pip {
        package: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        binaries: Vec<String>,
    },
    /// A crate built with `cargo install --root`.
    Cargo {
        #[serde(rename = "crate")]
        crate_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        binaries: Vec<String>,
    },
    /// A Go program built with `go install`, into a directory of its own.
    Go {
        package: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        binaries: Vec<String>,
    },
}

impl Recipe {
    /// The executables the recipe puts on the lookup path.
    pub fn binaries(&self) -> &[String] {
        match self {
            Recipe::GithubRelease { binaries, .. }
            | Recipe::Npm { binaries, .. }
            | Recipe::Pip { binaries, .. }
            | Recipe::Cargo { binaries, .. }
            | Recipe::Go { binaries, .. } => binaries,
        }
    }
}

/// A tool Grove can install: a language server or something it needs.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Tool {
    /// Names the tool: `taplo`, or `<extension>:<id>` for an extension's.
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub install: Recipe,
    /// The extension that brought the tool, empty for Grove's own.
    #[serde(default)]
    pub source: String,
}

/// The `<os>-<arch>` this build runs on, as recipes name platforms.
pub fn current_platform() -> String {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    format!("{os}-{arch}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recipe_reads_as_an_extension_writes_it() {
        let text = r#"{ "kind": "github-release", "repo": "tamasfe/taplo",
            "assets": { "linux-x64": "taplo-linux-x86_64.gz" }, "binaries": ["taplo"] }"#;
        let recipe: Recipe = serde_json::from_str(text).unwrap();
        assert_eq!(recipe.binaries(), ["taplo"]);
        let Recipe::GithubRelease { archive, tag, .. } = &recipe else { panic!("not a release") };
        assert_eq!((*archive, tag.as_deref()), (Archive::Auto, None));
        let cargo: Recipe = serde_json::from_str(r#"{ "kind": "cargo", "crate": "taplo-cli", "binaries": ["taplo"] }"#).unwrap();
        assert_eq!(cargo, Recipe::Cargo { crate_name: "taplo-cli".to_string(), version: None, binaries: vec!["taplo".to_string()] });
        assert!(serde_json::from_str::<Recipe>(r#"{ "kind": "apt", "binaries": [] }"#).is_err());
    }

    #[test]
    fn the_archive_is_read_from_the_asset_name_unless_the_recipe_says() {
        assert_eq!(Archive::Auto.resolve("a-1.0.tar.gz"), Archive::TarGz);
        assert_eq!(Archive::Auto.resolve("a.tgz"), Archive::TarGz);
        assert_eq!(Archive::Auto.resolve("clangd-linux-1.zip"), Archive::Zip);
        assert_eq!(Archive::Auto.resolve("taplo-linux-x86_64.gz"), Archive::Gz);
        assert_eq!(Archive::Auto.resolve("surrealql-language-server-linux-amd64"), Archive::None);
        assert_eq!(Archive::Zip.resolve("odd-name"), Archive::Zip);
    }
}
