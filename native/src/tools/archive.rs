//! Unpacking what a release asset is: a gzipped file, a gzipped tarball or a zip. Every path in
//! an archive is kept inside the directory it is unpacked to, and links are not made.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;

use super::recipe::Archive;

/// The most an archive may unpack to, so a hostile one cannot fill the disk.
const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;

/// Unpacks `file` into `destination` as `kind` says. A gzipped single file becomes
/// `destination/<single_name>`; the others are unpacked as they are laid out.
pub fn unpack(file: &Path, kind: Archive, destination: &Path, single_name: &str) -> Result<(), String> {
    match kind {
        Archive::Gz => unpack_gz(file, &destination.join(single_name)),
        Archive::TarGz => unpack_tar_gz(file, destination),
        Archive::Zip => unpack_zip(file, destination),
        Archive::None | Archive::Auto => copy_file(file, &destination.join(single_name)),
    }
}

/// A file that is not an archive, put where the tool is expected.
fn copy_file(file: &Path, target: &Path) -> Result<(), String> {
    std::fs::copy(file, target).map(|_| ()).map_err(|error| format!("could not copy {}: {error}", file.display()))
}

/// A gzipped single file, unpacked to `target`.
fn unpack_gz(file: &Path, target: &Path) -> Result<(), String> {
    let source = std::fs::File::open(file).map_err(|error| format!("could not read {}: {error}", file.display()))?;
    let mut decoder = GzDecoder::new(source).take(MAX_UNPACKED_BYTES);
    let mut output =
        std::fs::File::create(target).map_err(|error| format!("could not write {}: {error}", target.display()))?;
    std::io::copy(&mut decoder, &mut output).map_err(|error| format!("the download is not valid gzip ({error})"))?;
    output.flush().map_err(|error| error.to_string())
}

/// A gzipped tarball, unpacked under `destination`.
fn unpack_tar_gz(file: &Path, destination: &Path) -> Result<(), String> {
    let source = std::fs::File::open(file).map_err(|error| format!("could not read {}: {error}", file.display()))?;
    let mut archive = tar::Archive::new(GzDecoder::new(source).take(MAX_UNPACKED_BYTES));
    let entries = archive.entries().map_err(|error| format!("the download is not a tarball ({error})"))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("the tarball is damaged ({error})"))?;
        let entry_type = entry.header().entry_type();
        let path = entry.path().map_err(|error| format!("the tarball has a bad path ({error})"))?.into_owned();
        let Some(relative) = safe_relative(&path) else {
            continue;
        };
        let target = destination.join(relative);
        if entry_type.is_dir() {
            std::fs::create_dir_all(&target).map_err(|error| format!("could not create {}: {error}", target.display()))?;
        } else if entry_type.is_file() {
            make_parent(&target)?;
            entry.unpack(&target).map_err(|error| format!("could not unpack {}: {error}", target.display()))?;
        }
    }
    Ok(())
}

/// A zip archive, unpacked under `destination`.
fn unpack_zip(file: &Path, destination: &Path) -> Result<(), String> {
    let source = std::fs::File::open(file).map_err(|error| format!("could not read {}: {error}", file.display()))?;
    let mut archive = zip::ZipArchive::new(source).map_err(|error| format!("the download is not a zip file ({error})"))?;
    let mut unpacked: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| format!("the zip file is damaged ({error})"))?;
        let Some(relative) = entry.enclosed_name().and_then(|name| safe_relative(&name)) else {
            continue;
        };
        let target = destination.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|error| format!("could not create {}: {error}", target.display()))?;
            continue;
        }
        unpacked += entry.size();
        if unpacked > MAX_UNPACKED_BYTES {
            return Err("the archive unpacks to more than a gigabyte, so it was not unpacked".to_string());
        }
        make_parent(&target)?;
        let mut output = std::fs::File::create(&target).map_err(|error| format!("could not write {}: {error}", target.display()))?;
        std::io::copy(&mut entry, &mut output).map_err(|error| format!("could not unpack {}: {error}", target.display()))?;
        set_mode(&target, entry.unix_mode());
    }
    Ok(())
}

/// Makes the folder a file goes in.
fn make_parent(target: &Path) -> Result<(), String> {
    let Some(parent) = target.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(parent).map_err(|error| format!("could not create {}: {error}", parent.display()))
}

/// Gives a file the permissions the archive recorded for it, when it recorded some.
fn set_mode(target: &Path, mode: Option<u32>) {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        let _ = std::fs::set_permissions(target, std::fs::Permissions::from_mode(mode & 0o777));
    }
}

/// An archive path that stays inside the folder it is unpacked to, or None.
pub fn safe_relative(path: &Path) -> Option<PathBuf> {
    let mut relative = PathBuf::new();
    for component in path.components() {
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

    /// A fresh directory in the temp dir.
    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("grove-archive-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn a_gzipped_file_becomes_the_named_binary() {
        let root = scratch("gz");
        let file = root.join("asset.gz");
        let mut encoder = GzEncoder::new(std::fs::File::create(&file).unwrap(), Compression::default());
        encoder.write_all(b"binary contents").unwrap();
        encoder.finish().unwrap();
        unpack(&file, Archive::Gz, &root, "taplo").unwrap();
        assert_eq!(std::fs::read(root.join("taplo")).unwrap(), b"binary contents");
    }

    #[test]
    fn a_tarball_keeps_its_layout_and_never_leaves_the_folder() {
        let root = scratch("tar");
        let file = root.join("asset.tar.gz");
        let mut builder = tar::Builder::new(GzEncoder::new(std::fs::File::create(&file).unwrap(), Compression::default()));
        for (path, content) in [("bin/tool", "run"), ("main.lua", "x"), ("../outside", "no")] {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o755);
            header.set_entry_type(tar::EntryType::Regular);
            header.as_old_mut().name[..path.len()].copy_from_slice(path.as_bytes());
            header.set_cksum();
            builder.append(&header, content.as_bytes()).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
        let target = root.join("out");
        std::fs::create_dir_all(&target).unwrap();
        unpack(&file, Archive::TarGz, &target, "unused").unwrap();
        assert_eq!(std::fs::read_to_string(target.join("bin/tool")).unwrap(), "run");
        assert!(target.join("main.lua").exists());
        assert!(!root.join("outside").exists());
    }

    #[test]
    fn a_zip_keeps_its_layout_and_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("zip");
        let file = root.join("asset.zip");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&file).unwrap());
        let options = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
        writer.start_file("clangd_1.0/bin/clangd", options).unwrap();
        writer.write_all(b"elf").unwrap();
        writer.finish().unwrap();
        let target = root.join("out");
        std::fs::create_dir_all(&target).unwrap();
        unpack(&file, Archive::Zip, &target, "unused").unwrap();
        let unpacked = target.join("clangd_1.0/bin/clangd");
        assert_eq!(std::fs::read(&unpacked).unwrap(), b"elf");
        assert_eq!(std::fs::metadata(&unpacked).unwrap().permissions().mode() & 0o111, 0o111);
    }

    #[test]
    fn a_bare_file_is_copied_under_the_binary_name() {
        let root = scratch("none");
        let file = root.join("surrealql-language-server-linux-amd64");
        std::fs::write(&file, "elf").unwrap();
        unpack(&file, Archive::None, &root, "surrealql-language-server").unwrap();
        assert_eq!(std::fs::read(root.join("surrealql-language-server")).unwrap(), b"elf");
    }

    #[test]
    fn paths_that_go_up_or_are_absolute_are_refused() {
        assert_eq!(safe_relative(Path::new("a/./b")), Some(PathBuf::from("a/b")));
        assert_eq!(safe_relative(Path::new("../a")), None);
        assert_eq!(safe_relative(Path::new("/a")), None);
        assert_eq!(safe_relative(Path::new("")), None);
    }
}
