//! The ex commands typed after `:`: saving, closing, opening, going to a line and substituting.

use crate::command::Command;
use crate::movement::Motion;
use crate::vim::types::{AppRequest, LineRange};

/// The commands an ex command line makes. From visual mode the line starts with `'<,'>`.
pub fn parse_ex(line: &str) -> Vec<Command> {
    let text = line.trim().trim_start_matches(':').trim();
    if text.is_empty() {
        return vec![Command::Noop];
    }
    if let Some(row) = line_target(text) {
        return vec![goto_command(row)];
    }
    let (range, text) = split_range(text);
    if text.is_empty() {
        return vec![Command::Noop];
    }
    let name_length = text.chars().take_while(|character| character.is_ascii_alphabetic()).count();
    let (name, rest) = text.split_at(name_length);
    let bang = rest.starts_with('!');
    let rest = rest.trim_start_matches('!');
    let argument = rest.trim();
    if name == "s" || name == "substitute" {
        return substitute(range, rest);
    }
    match name {
        "w" | "write" => write(argument),
        "q" | "quit" | "clo" | "close" => vec![Command::Request { request: AppRequest::CloseTab { discard: bang } }],
        "wq" | "x" | "xit" | "exit" => {
            vec![Command::Save, Command::Request { request: AppRequest::CloseTab { discard: false } }]
        }
        "e" | "edit" | "open" => edit(argument),
        "noh" | "nohlsearch" => vec![Command::ClearSearchHighlight],
        "set" | "se" => vec![Command::Noop],
        _ => vec![Command::Fail { message: format!("E492: Not an editor command: {text}") }],
    }
}

/// The lines in front of a command, and what is left of the text.
fn split_range(text: &str) -> (LineRange, &str) {
    if let Some(rest) = text.strip_prefix("'<,'>") {
        return (LineRange::Selected, rest.trim_start());
    }
    if let Some(rest) = text.strip_prefix('%') {
        return (LineRange::All, rest.trim_start());
    }
    (LineRange::Current, text)
}

/// `:w`.
fn write(argument: &str) -> Vec<Command> {
    if argument.is_empty() {
        return vec![Command::Save];
    }
    vec![Command::Fail { message: "E: writing to another file is not supported".to_string() }]
}

/// `:e path`.
fn edit(argument: &str) -> Vec<Command> {
    if argument.is_empty() {
        return vec![Command::Fail { message: "E32: No file name".to_string() }];
    }
    vec![Command::Request { request: AppRequest::OpenFile { path: argument.to_string() } }]
}

/// `:s/pattern/replacement/flags`, with any character that is not a letter or a digit instead of the slashes.
fn substitute(range: LineRange, rest: &str) -> Vec<Command> {
    let mut characters = rest.chars();
    let Some(delimiter) =
        characters.next().filter(|character| !character.is_alphanumeric() && !character.is_whitespace())
    else {
        return vec![Command::Fail { message: "E486: Pattern not found".to_string() }];
    };
    let pieces = split_unescaped(characters.as_str(), delimiter);
    let pattern = pieces.first().cloned().unwrap_or_default();
    let replacement = pieces.get(1).cloned().unwrap_or_default();
    let flags = pieces.get(2).cloned().unwrap_or_default();
    vec![Command::Substitute {
        range,
        pattern,
        replacement,
        global: flags.contains('g'),
        ignore_case: flags.contains('i'),
    }]
}

/// Splits text at a delimiter that is not escaped with a backslash, removing the escapes before delimiters.
fn split_unescaped(text: &str, delimiter: char) -> Vec<String> {
    let mut pieces = vec![String::new()];
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\\' && characters.peek() == Some(&delimiter) {
            if let Some(piece) = pieces.last_mut() {
                piece.push(delimiter);
            }
            characters.next();
            continue;
        }
        if character == delimiter {
            pieces.push(String::new());
            continue;
        }
        if let Some(piece) = pieces.last_mut() {
            piece.push(character);
        }
    }
    pieces
}

/// The line a bare number or `$` goes to, counted from zero, or none when the text is neither.
pub fn line_target(text: &str) -> Option<usize> {
    let text = text.trim().trim_start_matches(':').trim();
    if text == "$" {
        return Some(usize::MAX);
    }
    let number: usize = text.parse().ok()?;
    Some(number.saturating_sub(1))
}

/// The command that goes to a line.
pub fn goto_command(row: usize) -> Command {
    Command::VimMove { motion: Motion::Line(row), count: 1, extend: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_and_quit_commands() {
        assert_eq!(parse_ex("w"), vec![Command::Save]);
        assert_eq!(parse_ex("q"), vec![Command::Request { request: AppRequest::CloseTab { discard: false } }]);
        assert_eq!(parse_ex("q!"), vec![Command::Request { request: AppRequest::CloseTab { discard: true } }]);
        assert_eq!(parse_ex("wq").len(), 2);
        assert_eq!(
            parse_ex("e src/main.rs"),
            vec![Command::Request { request: AppRequest::OpenFile { path: "src/main.rs".to_string() } }]
        );
    }

    #[test]
    fn substitute_takes_its_pieces_and_flags() {
        assert_eq!(
            parse_ex("%s/foo/bar/g"),
            vec![Command::Substitute {
                range: LineRange::All,
                pattern: "foo".to_string(),
                replacement: "bar".to_string(),
                global: true,
                ignore_case: false
            }]
        );
        assert_eq!(
            parse_ex("s#a\\#b#c#"),
            vec![Command::Substitute {
                range: LineRange::Current,
                pattern: "a#b".to_string(),
                replacement: "c".to_string(),
                global: false,
                ignore_case: false
            }]
        );
    }

    #[test]
    fn noh_turns_the_search_highlight_off() {
        assert_eq!(parse_ex("noh"), vec![Command::ClearSearchHighlight]);
        assert_eq!(parse_ex("nohlsearch"), vec![Command::ClearSearchHighlight]);
    }

    #[test]
    fn a_number_is_a_line() {
        assert_eq!(line_target("12"), Some(11));
        assert_eq!(line_target("$"), Some(usize::MAX));
        assert_eq!(line_target("w"), None);
    }

    #[test]
    fn unknown_commands_fail_with_a_message() {
        assert!(matches!(parse_ex("frobnicate").as_slice(), [Command::Fail { .. }]));
    }
}
