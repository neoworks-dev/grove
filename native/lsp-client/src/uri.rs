//! `file://` URIs for paths, as language servers name documents.

use std::path::{Path, PathBuf};

/// The URI of an absolute path. Characters outside the unreserved set and `/` are percent-encoded.
pub fn uri_from_path(path: &Path) -> String {
    let mut uri = String::from("file://");
    for &byte in path.to_string_lossy().as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~') {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

/// The path a `file://` URI names, or none for any other kind of URI.
pub fn path_from_uri(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let mut bytes = Vec::with_capacity(rest.len());
    let raw = rest.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%' && index + 2 < raw.len() {
            let hex = std::str::from_utf8(&raw[index + 1..index + 3]).ok()?;
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                bytes.push(byte);
                index += 3;
                continue;
            }
        }
        bytes.push(raw[index]);
        index += 1;
    }
    Some(PathBuf::from(String::from_utf8(bytes).ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_round_trip_through_uris() {
        for path in ["/home/a/b.rs", "/tmp/with space/ü.ts", "/tmp/100%/a#b?.rs"] {
            let uri = uri_from_path(Path::new(path));
            assert!(uri.starts_with("file:///"));
            assert_eq!(path_from_uri(&uri), Some(PathBuf::from(path)));
        }
    }

    #[test]
    fn spaces_are_encoded_and_other_schemes_are_not_paths() {
        assert_eq!(uri_from_path(Path::new("/a b")), "file:///a%20b");
        assert_eq!(path_from_uri("https://example.com/a"), None);
        assert_eq!(path_from_uri("file:///a%2"), Some(PathBuf::from("/a%2")));
    }
}
