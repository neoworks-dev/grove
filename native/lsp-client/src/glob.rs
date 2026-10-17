//! The glob patterns servers use to say which files they want to hear about: `**` for any
//! number of directories, `*` and `?` within a name, `{a,b}` for alternatives and `[abc]` for
//! a set of characters.

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
