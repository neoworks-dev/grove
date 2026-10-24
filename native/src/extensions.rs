//! Installing an extension from the tarball npm serves for it. The UI downloads the tarball
//! with `fetch` and hands the bytes to `install_extension`, which checks them against the hash
//! the registry published, unpacks them and puts the result in place of any earlier install.
//! No `npm` binary is involved.
//!
//! The package is unpacked beside its final place and moved there once it has proved to be an
//! extension, so a download that is corrupt, is not the package asked for, or has no `grove`
//! field never replaces a working install.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use base64::Engine as _;
use flate2::read::GzDecoder;
use serde_json::{Value, json};
use sha1::Sha1;
use sha2::{Digest, Sha512};
use svelte_gpui::{CommandError, Commands};

/// The most a tarball may unpack to, so a hostile archive cannot fill the disk.
const MAX_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;

/// Registers `install_extension`.
pub fn register(commands: Commands) -> Commands {
    commands.command_with_bytes("install_extension", |args, bytes| {
        let bytes = bytes.ok_or_else(|| "install_extension needs the tarball as bytes".to_string())?;
        install_extension(&args, &bytes).map_err(CommandError::from)
    })
}

/// Installs the tarball into `args.directory`. `args.name` is the package that was asked for, and
/// `args.integrity` and `args.shasum` are what the registry says the tarball hashes to.
fn install_extension(args: &Value, tarball: &[u8]) -> Result<Value, String> {
    let directory = PathBuf::from(text(args, "directory").ok_or("install_extension needs a directory")?);
    let name = text(args, "name").ok_or("install_extension needs the package name")?;
    verify_hash(tarball, text(args, "integrity"), text(args, "shasum"))?;

    let staging = staging_path(&directory)?;
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|error| format!("could not create {}: {error}", staging.display()))?;
    let installed = unpack_and_check(tarball, &staging, name);
    let version = match installed {
        Ok(version) => version,
        Err(message) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(message);
        }
    };
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::rename(&staging, &directory)
        .map_err(|error| format!("could not move the package to {}: {error}", directory.display()))?;
    Ok(json!({ "name": name, "version": version }))
}

/// A string argument that is present and not empty.
fn text<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).filter(|value| !value.is_empty())
}

/// The directory the package is unpacked in before it replaces `directory`: a hidden sibling, which
/// the extension lists skip.
fn staging_path(directory: &Path) -> Result<PathBuf, String> {
    let name = directory.file_name().ok_or("the extension directory has no name")?;
    Ok(directory.with_file_name(format!(".staging-{}", name.to_string_lossy())))
}

/// Checks the tarball against the registry's `integrity` (`sha512-<base64>`), or its older
/// `shasum` (hex SHA-1) when there is none. A registry that gives neither is refused: an
/// install that cannot be checked is not made.
fn verify_hash(tarball: &[u8], integrity: Option<&str>, shasum: Option<&str>) -> Result<(), String> {
    if let Some(integrity) = integrity {
        let expected = integrity.strip_prefix("sha512-").ok_or("the registry's integrity is not a sha512 hash")?;
        let actual = base64::engine::general_purpose::STANDARD.encode(Sha512::digest(tarball));
        if actual == expected {
            return Ok(());
        }
        return Err("the download does not match the hash the registry published".to_string());
    }
    if let Some(shasum) = shasum {
        let actual: String = Sha1::digest(tarball).iter().map(|byte| format!("{byte:02x}")).collect();
        if actual.eq_ignore_ascii_case(shasum) {
            return Ok(());
        }
        return Err("the download does not match the hash the registry published".to_string());
    }
    Err("the registry published no hash for this version, so it cannot be checked".to_string())
}

/// Unpacks into `staging` and checks that it is the extension asked for; returns its version.
fn unpack_and_check(tarball: &[u8], staging: &Path, expected_name: &str) -> Result<String, String> {
    unpack(tarball, staging)?;
    let text = std::fs::read_to_string(staging.join("package.json")).map_err(|_| "the package has no package.json".to_string())?;
    let manifest: Value = serde_json::from_str(&text).map_err(|error| format!("package.json is not valid JSON ({error})"))?;
    let name = manifest.get("name").and_then(Value::as_str).unwrap_or_default();
    if name != expected_name {
        return Err(format!("the package is called \"{name}\", not \"{expected_name}\""));
    }
    if !manifest.get("grove").is_some_and(Value::is_object) {
        return Err(format!("\"{expected_name}\" has no \"grove\" field in its package.json, so it is not a Grove extension"));
    }
    Ok(manifest.get("version").and_then(Value::as_str).unwrap_or("0.0.0").to_string())
}

/// Unpacks a gzipped tarball into `destination`, dropping the leading folder npm puts every
/// file in. Files only: links and special entries are skipped, and so is anything whose path
/// would leave the destination.
fn unpack(tarball: &[u8], destination: &Path) -> Result<(), String> {
    let decoder = GzDecoder::new(tarball).take(MAX_UNPACKED_BYTES);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive.entries().map_err(|error| format!("the download is not a tarball ({error})"))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("the tarball is damaged ({error})"))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path().map_err(|error| format!("the tarball has a bad path ({error})"))?.into_owned();
        let Some(relative) = inside_package(&path) else {
            continue;
        };
        let target = destination.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("could not create {}: {error}", parent.display()))?;
        }
        entry.unpack(&target).map_err(|error| format!("could not unpack {}: {error}", target.display()))?;
    }
    Ok(())
}

/// A tarball path without its first folder, or None when what is left is empty or goes anywhere
/// but down.
fn inside_package(path: &Path) -> Option<PathBuf> {
    let mut components = path.components();
    components.next()?;
    let mut relative = PathBuf::new();
    for component in components {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if relative.as_os_str().is_empty() {
        return None;
    }
    Some(relative)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;

    /// A tarball with these files, each under `package/`, as `npm pack` makes one.
    fn tarball(files: &[(&str, &str)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
        for (path, content) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::Regular);
            // `append_data` refuses `..`, so the path is written into the header as it is.
            let bytes = header.as_old_mut();
            bytes.name[..path.len()].copy_from_slice(path.as_bytes());
            header.set_cksum();
            builder.append(&header, content.as_bytes()).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    /// The registry's `integrity` for some bytes.
    fn integrity(bytes: &[u8]) -> String {
        format!("sha512-{}", base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes)))
    }

    /// A fresh directory in the temp dir.
    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("grove-extensions-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    const MANIFEST: &str = r#"{"name":"grove-hello","version":"1.2.0","grove":{"plugins":[]}}"#;

    #[test]
    fn a_checked_tarball_is_unpacked_without_its_leading_folder() {
        let root = scratch("install");
        let bytes = tarball(&[("package/package.json", MANIFEST), ("package/dist/hello.js", "run()")]);
        let target = root.join("grove-hello");
        let args = json!({ "directory": target.display().to_string(), "name": "grove-hello", "integrity": integrity(&bytes) });
        let result = install_extension(&args, &bytes).unwrap();
        assert_eq!(result, json!({ "name": "grove-hello", "version": "1.2.0" }));
        assert_eq!(std::fs::read_to_string(target.join("dist/hello.js")).unwrap(), "run()");
        assert!(!root.join(".staging-grove-hello").exists());
    }

    #[test]
    fn an_install_replaces_the_earlier_one_whole() {
        let root = scratch("replace");
        let target = root.join("grove-hello");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("stale.js"), "old").unwrap();
        let bytes = tarball(&[("package/package.json", MANIFEST)]);
        let args = json!({ "directory": target.display().to_string(), "name": "grove-hello", "integrity": integrity(&bytes) });
        install_extension(&args, &bytes).unwrap();
        assert!(!target.join("stale.js").exists());
        assert!(target.join("package.json").exists());
    }

    #[test]
    fn the_older_shasum_is_enough_when_there_is_no_integrity() {
        let bytes = tarball(&[("package/package.json", MANIFEST)]);
        let shasum: String = Sha1::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect();
        assert!(verify_hash(&bytes, None, Some(&shasum)).is_ok());
        assert!(verify_hash(&bytes, None, Some("0000")).is_err());
        assert!(verify_hash(&bytes, None, None).is_err());
    }

    #[test]
    fn a_download_that_does_not_match_its_hash_changes_nothing() {
        let root = scratch("tampered");
        let target = root.join("grove-hello");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("keep.js"), "kept").unwrap();
        let bytes = tarball(&[("package/package.json", MANIFEST)]);
        let args = json!({ "directory": target.display().to_string(), "name": "grove-hello", "integrity": integrity(b"something else") });
        let message = install_extension(&args, &bytes).unwrap_err();
        assert!(message.contains("does not match the hash"), "{message}");
        assert_eq!(std::fs::read_to_string(target.join("keep.js")).unwrap(), "kept");
    }

    #[test]
    fn a_package_that_is_not_an_extension_or_not_the_one_asked_for_is_refused() {
        let root = scratch("refused");
        let target = root.join("grove-hello");
        let plain = tarball(&[("package/package.json", r#"{"name":"grove-hello","version":"1.0.0"}"#)]);
        let args = json!({ "directory": target.display().to_string(), "name": "grove-hello", "integrity": integrity(&plain) });
        assert!(install_extension(&args, &plain).unwrap_err().contains("not a Grove extension"));
        let other = tarball(&[("package/package.json", r#"{"name":"left-pad","grove":{}}"#)]);
        let args = json!({ "directory": target.display().to_string(), "name": "grove-hello", "integrity": integrity(&other) });
        assert!(install_extension(&args, &other).unwrap_err().contains("not \"grove-hello\""));
        assert!(!target.exists());
        assert!(!root.join(".staging-grove-hello").exists());
    }

    #[test]
    fn paths_that_leave_the_package_are_not_unpacked() {
        let root = scratch("traversal");
        let bytes = tarball(&[
            ("package/package.json", MANIFEST),
            ("package/../escaped.txt", "no"),
            ("/absolute.txt", "no"),
        ]);
        let target = root.join("grove-hello");
        let args = json!({ "directory": target.display().to_string(), "name": "grove-hello", "integrity": integrity(&bytes) });
        install_extension(&args, &bytes).unwrap();
        assert!(!root.join("escaped.txt").exists());
        assert!(!target.join("escaped.txt").exists());
        assert!(!Path::new("/absolute.txt").exists());
    }
}
