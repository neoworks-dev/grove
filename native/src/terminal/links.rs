//! Links in the text of a terminal row: web addresses, and file paths with an optional line and
//! column, as compilers and test runners print them. Control-click on one opens it.

use std::path::{Path, PathBuf};

use alacritty_terminal::Term;
use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::Flags;

/// Where a link leads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkTarget {
    Url(String),
    /// A file that exists, with a position in it counted from one.
    File {
        path: String,
        line: Option<u32>,
        column: Option<u32>,
    },
}

/// A link and the cells it covers, for underlining.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    pub target: LinkTarget,
    /// The grid line it is on.
    pub line: Line,
    pub first_column: usize,
    /// One past the last column.
    pub end_column: usize,
}

/// The URL schemes that make a token a link.
const URL_SCHEMES: [&str; 5] = ["http://", "https://", "ftp://", "file://", "mailto:"];

/// What a token never contains: it ends at whitespace and at these.
const TOKEN_BREAKS: [char; 9] = ['"', '\'', '<', '>', '|', '`', '\0', '\u{2502}', '\u{2503}'];

/// What may trail a link without being part of it.
const TRAILING_PUNCTUATION: [char; 8] = ['.', ',', ';', ':', '!', '?', ')', ']'];

/// What may start a path without being part of it.
const LEADING_PUNCTUATION: [char; 3] = ['(', '[', '{'];

/// The characters of a grid line, one for each column. The second half of a double-width
/// character and any empty cell is a break, so a link never spans one.
pub fn row_text<L: EventListener>(term: &Term<L>, line: Line) -> Vec<char> {
    let grid = term.grid();
    if line < term.topmost_line() || line > term.bottommost_line() {
        return Vec::new();
    }
    let mut characters = Vec::with_capacity(term.columns());
    for column in 0..term.columns() {
        let cell = &grid[Point::new(line, Column(column))];
        if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
            characters.push('\0');
            continue;
        }
        match cell.c {
            ' ' | '\0' => characters.push(' '),
            other => characters.push(other),
        }
    }
    characters
}

/// The link under `column` of a row of characters, if there is one. A file path counts only
/// when the file exists, looked for from `working_directory` when the path is relative.
pub fn find_link(characters: &[char], column: usize, line: Line, working_directory: &str) -> Option<Link> {
    let (first, end) = token_around(characters, column)?;
    let token: String = characters[first..end].iter().collect();
    if let Some((trimmed_start, trimmed_end)) = trimmed_bounds(&token) {
        let first_column = first + token[..trimmed_start].chars().count();
        let end_column = first + token[..trimmed_end].chars().count();
        if column < first_column || column >= end_column {
            return None;
        }
        let trimmed = &token[trimmed_start..trimmed_end];
        let target = target_of(trimmed, working_directory)?;
        return Some(Link { target, line, first_column, end_column });
    }
    None
}

/// The span of a token around a column, as the first character and one past the last.
fn token_around(characters: &[char], column: usize) -> Option<(usize, usize)> {
    let at = *characters.get(column)?;
    if breaks_token(at) {
        return None;
    }
    let mut first = column;
    while first > 0 && !breaks_token(characters[first - 1]) {
        first -= 1;
    }
    let mut end = column + 1;
    while end < characters.len() && !breaks_token(characters[end]) {
        end += 1;
    }
    Some((first, end))
}

/// Whether a character ends a token.
fn breaks_token(character: char) -> bool {
    character.is_whitespace() || TOKEN_BREAKS.contains(&character)
}

/// The byte range of a token without the punctuation that wraps it, or none if nothing is left.
fn trimmed_bounds(token: &str) -> Option<(usize, usize)> {
    let mut start = 0;
    let mut end = token.len();
    while start < end {
        let character = token[start..].chars().next()?;
        if !LEADING_PUNCTUATION.contains(&character) {
            break;
        }
        start += character.len_utf8();
    }
    while end > start {
        let character = token[..end].chars().next_back()?;
        let balanced =
            character == ')' && token[start..end].matches('(').count() >= token[start..end].matches(')').count();
        if !TRAILING_PUNCTUATION.contains(&character) || balanced {
            break;
        }
        end -= character.len_utf8();
    }
    if start >= end {
        return None;
    }
    Some((start, end))
}

/// What a trimmed token links to: a URL, or a file that exists.
fn target_of(token: &str, working_directory: &str) -> Option<LinkTarget> {
    if URL_SCHEMES.iter().any(|scheme| token.starts_with(scheme) && token.len() > scheme.len()) {
        return Some(LinkTarget::Url(token.to_string()));
    }
    let (path, line, column) = split_location(token);
    let resolved = resolve_path(path, working_directory)?;
    if !resolved.is_file() {
        return None;
    }
    Some(LinkTarget::File { path: resolved.display().to_string(), line, column })
}

/// Splits `path:line:column` into its parts. A suffix that is not numbers stays in the path.
pub fn split_location(token: &str) -> (&str, Option<u32>, Option<u32>) {
    let Some((rest, last)) = token.rsplit_once(':') else {
        return (token, None, None);
    };
    let Ok(last_number) = last.parse::<u32>() else {
        return (token, None, None);
    };
    let Some((path, middle)) = rest.rsplit_once(':') else {
        return (rest, Some(last_number), None);
    };
    match middle.parse::<u32>() {
        Ok(line) => (path, Some(line), Some(last_number)),
        Err(_) => (rest, Some(last_number), None),
    }
}

/// An absolute path for what a terminal printed: `~` expanded, a relative path joined to the
/// working directory.
fn resolve_path(path: &str, working_directory: &str) -> Option<PathBuf> {
    if path.is_empty() {
        return None;
    }
    if let Some(home_relative) = path.strip_prefix("~/") {
        let home = std::env::var_os("HOME")?;
        return Some(Path::new(&home).join(home_relative));
    }
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Some(candidate.to_path_buf());
    }
    if working_directory.is_empty() {
        return None;
    }
    let relative = path.strip_prefix("./").unwrap_or(path);
    Some(Path::new(working_directory).join(relative))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn characters(text: &str) -> Vec<char> {
        text.chars().collect()
    }

    fn temp_directory(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("grove-links-{name}-{}", std::process::id()));
        std::fs::create_dir_all(directory.join("src")).expect("a directory");
        directory
    }

    #[test]
    fn a_url_is_found_under_any_of_its_characters() {
        let row = characters("see https://example.com/a?b=1, then");
        let link = find_link(&row, 12, Line(0), "").expect("a link");
        assert_eq!(link.target, LinkTarget::Url("https://example.com/a?b=1".to_string()));
        assert_eq!((link.first_column, link.end_column), (4, 29));
        assert_eq!(find_link(&row, 1, Line(0), ""), None);
    }

    #[test]
    fn a_url_in_parentheses_or_with_a_trailing_full_stop_is_trimmed() {
        let row = characters("(https://example.com/x). done");
        let link = find_link(&row, 5, Line(0), "").expect("a link");
        assert_eq!(link.target, LinkTarget::Url("https://example.com/x".to_string()));
    }

    #[test]
    fn a_path_with_a_line_and_column_opens_that_file() {
        let directory = temp_directory("path");
        std::fs::write(directory.join("src/main.rs"), "fn main() {}").expect("a file");
        let row = characters("error: src/main.rs:12:5: oops");
        let link = find_link(&row, 10, Line(3), directory.to_str().expect("path")).expect("a link");
        let expected = directory.join("src/main.rs").display().to_string();
        assert_eq!(link.target, LinkTarget::File { path: expected, line: Some(12), column: Some(5) });
        assert_eq!(link.line, Line(3));
        assert_eq!((link.first_column, link.end_column), (7, 23));
    }

    #[test]
    fn a_path_to_a_file_that_does_not_exist_is_no_link() {
        let directory = temp_directory("missing");
        let row = characters("src/nothing.rs:3");
        assert_eq!(find_link(&row, 2, Line(0), directory.to_str().expect("path")), None);
    }

    #[test]
    fn a_relative_path_needs_a_working_directory() {
        let row = characters("src/main.rs");
        assert_eq!(find_link(&row, 2, Line(0), ""), None);
    }

    #[test]
    fn locations_split_off_the_path() {
        assert_eq!(split_location("a/b.rs"), ("a/b.rs", None, None));
        assert_eq!(split_location("a/b.rs:7"), ("a/b.rs", Some(7), None));
        assert_eq!(split_location("a/b.rs:7:9"), ("a/b.rs", Some(7), Some(9)));
        assert_eq!(split_location("a/b.rs:x"), ("a/b.rs:x", None, None));
    }
}
