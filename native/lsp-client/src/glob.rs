//! The glob patterns servers use to say which files they want to hear about: `**` for any
//! number of directories, `*` and `?` within a name, `{a,b}` for alternatives and `[abc]` for
//! a set of characters.

use std::path::Path;

use serde_json::Value;

use crate::uri::path_from_uri;

/// What happened to a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileChange {
    Created,
    Changed,
    Deleted,
}

impl FileChange {
    /// The number the protocol gives the change.
    pub fn number(self) -> u8 {
        match self {
            FileChange::Created => 1,
            FileChange::Changed => 2,
            FileChange::Deleted => 3,
        }
    }

    /// The bit that stands for the change in a watcher's `kind`.
    fn bit(self) -> u64 {
        match self {
            FileChange::Created => 1,
            FileChange::Changed => 2,
            FileChange::Deleted => 4,
        }
    }
}

/// A pattern a server registered to hear about changes to files matching it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Watcher {
    /// The directory the pattern is relative to, when the server gave one.
    pub base: Option<std::path::PathBuf>,
    pub pattern: String,
    /// Which changes the watcher wants, as the protocol's bits: created, changed, deleted.
    pub kind: u64,
}

impl Watcher {
    /// Whether a change to a file is one the watcher wants. Patterns are relative to the watcher's
    /// base, or to the workspace root when it has none.
    pub fn wants(&self, path: &Path, root: &Path, change: FileChange) -> bool {
        if self.kind & change.bit() == 0 {
            return false;
        }
        if self.pattern.starts_with('/') {
            return matches(&self.pattern, &path.to_string_lossy());
        }
        let base = match &self.base {
            Some(base) => base.as_path(),
            None => root,
        };
        let Ok(relative) = path.strip_prefix(base) else {
            return false;
        };
        matches(&self.pattern, &relative.to_string_lossy())
    }
}

/// The watchers in the registration options of `workspace/didChangeWatchedFiles`.
pub fn parse_watchers(options: &Value) -> Vec<Watcher> {
    let Some(list) = options["watchers"].as_array() else {
        return Vec::new();
    };
    list.iter().filter_map(parse_watcher).collect()
}

/// One watcher, whose pattern is a glob or a glob with the folder it is relative to.
fn parse_watcher(entry: &Value) -> Option<Watcher> {
    let kind = entry["kind"].as_u64().unwrap_or(7);
    let glob = &entry["globPattern"];
    if let Some(pattern) = glob.as_str() {
        return Some(Watcher { base: None, pattern: pattern.to_string(), kind });
    }
    let pattern = glob["pattern"].as_str()?.to_string();
    let base_uri = match &glob["baseUri"] {
        Value::String(uri) => Some(uri.as_str()),
        other => other["uri"].as_str(),
    };
    Some(Watcher { base: base_uri.and_then(path_from_uri), pattern, kind })
}

/// Whether a path (with `/` separators) matches a pattern.
pub fn matches(pattern: &str, path: &str) -> bool {
    let expanded = expand_alternatives(pattern);
    expanded.iter().any(|pattern| match_here(pattern.as_bytes(), path.as_bytes()))
}

/// The patterns a pattern with `{a,b}` alternatives stands for, one for each choice.
fn expand_alternatives(pattern: &str) -> Vec<String> {
    let Some(open) = pattern.find('{') else {
        return vec![pattern.to_string()];
    };
    let Some(close) = matching_brace(pattern, open) else {
        return vec![pattern.to_string()];
    };
    let (before, inside, after) = (&pattern[..open], &pattern[open + 1..close], &pattern[close + 1..]);
    let mut result = Vec::new();
    for choice in split_top_level(inside) {
        result.extend(expand_alternatives(&format!("{before}{choice}{after}")));
    }
    result
}

/// The index of the `}` that closes the `{` at `open`.
fn matching_brace(pattern: &str, open: usize) -> Option<usize> {
    let mut depth = 0;
    for (index, character) in pattern.char_indices().skip_while(|(index, _)| *index < open) {
        match character {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

/// Splits on the commas that are not inside nested braces.
fn split_top_level(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut depth, mut start) = (0, 0);
    for (index, character) in text.char_indices() {
        match character {
            '{' => depth += 1,
            '}' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(&text[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(&text[start..]);
    parts
}

/// Matches a pattern without alternatives.
fn match_here(pattern: &[u8], path: &[u8]) -> bool {
    match pattern.first() {
        None => path.is_empty(),
        Some(b'*') if pattern.get(1) == Some(&b'*') => {
            let rest = pattern[2..].strip_prefix(b"/").unwrap_or(&pattern[2..]);
            if rest.is_empty() {
                return true;
            }
            (0..=path.len()).any(|skip| {
                let at_boundary = skip == 0 || path[skip - 1] == b'/';
                at_boundary && match_here(rest, &path[skip..])
            })
        }
        Some(b'*') => {
            let limit = path.iter().position(|byte| *byte == b'/').unwrap_or(path.len());
            (0..=limit).any(|skip| match_here(&pattern[1..], &path[skip..]))
        }
        Some(b'?') => path.first().is_some_and(|byte| *byte != b'/') && match_here(&pattern[1..], &path[1..]),
        Some(b'[') => match_set(pattern, path),
        Some(byte) => path.first() == Some(byte) && match_here(&pattern[1..], &path[1..]),
    }
}

/// Matches a `[abc]` or `[a-z]` set at the start of the pattern against the first byte of the path.
fn match_set(pattern: &[u8], path: &[u8]) -> bool {
    let Some(close) = pattern.iter().position(|byte| *byte == b']') else {
        return path.first() == Some(&b'[') && match_here(&pattern[1..], &path[1..]);
    };
    let Some(&candidate) = path.first() else {
        return false;
    };
    let set = &pattern[1..close];
    let (negated, set) = match set.first() {
        Some(b'!') | Some(b'^') => (true, &set[1..]),
        _ => (false, set),
    };
    let mut found = false;
    let mut index = 0;
    while index < set.len() {
        if set.get(index + 1) == Some(&b'-') && index + 2 < set.len() {
            found |= (set[index]..=set[index + 2]).contains(&candidate);
            index += 3;
        } else {
            found |= set[index] == candidate;
            index += 1;
        }
    }
    found != negated && match_here(&pattern[close + 1..], &path[1..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn double_stars_cross_directories_and_single_stars_do_not() {
        assert!(matches("**/*.ts", "src/deep/a.ts"));
        assert!(matches("**/*.ts", "a.ts"));
        assert!(!matches("*.ts", "src/a.ts"));
        assert!(matches("src/*.ts", "src/a.ts"));
        assert!(matches("**/tsconfig.json", "packages/app/tsconfig.json"));
        assert!(!matches("**/tsconfig.json", "packages/app/mytsconfig.json"));
    }

    #[test]
    fn watchers_are_read_in_both_forms_and_ask_for_the_changes_they_name() {
        let options = serde_json::json!({ "watchers": [
            { "globPattern": "**/*.ts" },
            { "globPattern": { "baseUri": "file:///work/app", "pattern": "*.json" }, "kind": 4 },
        ] });
        let watchers = parse_watchers(&options);
        assert_eq!(watchers.len(), 2);
        let root = Path::new("/work");
        assert!(watchers[0].wants(Path::new("/work/src/a.ts"), root, FileChange::Changed));
        assert!(!watchers[0].wants(Path::new("/elsewhere/a.ts"), root, FileChange::Changed));
        assert!(watchers[1].wants(Path::new("/work/app/x.json"), root, FileChange::Deleted));
        assert!(!watchers[1].wants(Path::new("/work/app/x.json"), root, FileChange::Created));
        assert!(!watchers[1].wants(Path::new("/work/x.json"), root, FileChange::Deleted));
    }

    #[test]
    fn a_pattern_that_is_an_absolute_path_is_matched_against_the_whole_path() {
        let options = serde_json::json!({ "watchers": [
            { "globPattern": "/work/app/**/*.rs" }, { "globPattern": "/work/app/**/Cargo.{toml,lock}" },
        ] });
        let watchers = parse_watchers(&options);
        let root = Path::new("/work/app");
        assert!(watchers[0].wants(Path::new("/work/app/src/deep/lib.rs"), root, FileChange::Created));
        assert!(!watchers[0].wants(Path::new("/other/src/lib.rs"), root, FileChange::Created));
        assert!(watchers[1].wants(Path::new("/work/app/member/Cargo.lock"), root, FileChange::Changed));
        assert!(!watchers[1].wants(Path::new("/work/app/member/Cargo.json"), root, FileChange::Changed));
    }

    #[test]
    fn alternatives_sets_and_single_characters() {
        assert!(matches("**/*.{ts,tsx,js}", "a/b.tsx"));
        assert!(!matches("**/*.{ts,tsx,js}", "a/b.css"));
        assert!(matches("**/{node_modules,.git}/**", "x/node_modules/y/z.js"));
        assert!(matches("file?.rs", "file1.rs"));
        assert!(!matches("file?.rs", "file12.rs"));
        assert!(matches("[ab]*.rs", "alpha.rs"));
        assert!(!matches("[!ab]*.rs", "alpha.rs"));
        assert!(matches("[a-c]x", "bx"));
    }
}
