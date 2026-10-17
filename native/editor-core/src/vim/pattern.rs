//! Vim's search patterns, read as regular expressions. A pattern is written the way vim's
//! default "magic" mode has it: `.`, `*`, `^`, `$` and `[]` are special, `\(`, `\|`, `\+`, `\?`,
//! `\{` and `\<` `\>` are the group, alternation, repeats and word edges, and plain `(`, `|`, `+`
//! and `?` are themselves. `\c` and `\C` make the whole pattern ignore case or not.

use regex::Regex;

/// A search pattern, ready to find matches in text.
#[derive(Clone, Debug)]
pub struct Pattern {
    regex: Regex,
}

impl Pattern {
    /// Reads a pattern typed after `/` or in `:s`. With `whole_word` the text is not a pattern
    /// but a word, which only matches with no word character next to it, as `*` searches.
    pub fn parse(text: &str, whole_word: bool, ignore_case: bool) -> Result<Pattern, String> {
        let (source, forced_case) = if whole_word { (whole_word_source(text), None) } else { translate(text) };
        let ignore = forced_case.unwrap_or(ignore_case);
        let flags = if ignore { "(?mi)" } else { "(?m)" };
        match Regex::new(&format!("{flags}{source}")) {
            Ok(regex) => Ok(Pattern { regex }),
            Err(_) => Err(format!("E383: Invalid search string: {text}")),
        }
    }

    /// The regular expression.
    pub fn regex(&self) -> &Regex {
        &self.regex
    }

    /// Where each match in `text` starts, as characters from its start, in order.
    pub fn starts_in(&self, text: &str) -> Vec<usize> {
        let mut starts = Vec::new();
        let mut counted_bytes = 0;
        let mut counted_characters = 0;
        for found in self.regex.find_iter(text) {
            counted_characters += text[counted_bytes..found.start()].chars().count();
            counted_bytes = found.start();
            starts.push(counted_characters);
        }
        starts
    }
}

/// The source of a pattern that matches a word exactly, with word edges where the word has word characters.
fn whole_word_source(word: &str) -> String {
    let edge = |character: Option<char>| match character {
        Some(character) if character.is_alphanumeric() || character == '_' => "\\b",
        _ => "",
    };
    format!("{}{}{}", edge(word.chars().next()), regex::escape(word), edge(word.chars().next_back()))
}

/// Turns vim's pattern syntax into the regex crate's, and reads which case `\c` or `\C` asked for.
fn translate(text: &str) -> (String, Option<bool>) {
    let mut source = String::new();
    let mut forced_case = None;
    let mut characters = text.chars().peekable();
    let mut in_repeat = false;
    while let Some(character) = characters.next() {
        match character {
            '\\' => match characters.next() {
                None => source.push_str("\\\\"),
                Some('<' | '>') => source.push_str("\\b"),
                Some('{') => {
                    in_repeat = true;
                    source.push('{');
                }
                Some('}') => {
                    in_repeat = false;
                    source.push('}');
                }
                Some(escaped @ ('(' | ')' | '|' | '+')) => source.push(escaped),
                Some('?' | '=') => source.push('?'),
                Some('c') => forced_case = Some(true),
                Some('C') => forced_case = Some(false),
                Some('/') => source.push('/'),
                Some(escaped) => {
                    source.push('\\');
                    source.push(escaped);
                }
            },
            '}' if in_repeat => {
                in_repeat = false;
                source.push('}');
            }
            '(' | ')' | '|' | '+' | '?' | '{' | '}' => {
                source.push('\\');
                source.push(character);
            }
            '[' => source.push_str(&bracket_class(&mut characters)),
            other => source.push(other),
        }
    }
    (source, forced_case)
}

/// A `[...]` class copied as written, or a literal bracket when it is never closed. The opening
/// bracket has been read already.
fn bracket_class(characters: &mut std::iter::Peekable<std::str::Chars>) -> String {
    let mut inside = String::new();
    let mut lookahead = characters.clone();
    if lookahead.peek() == Some(&'^') {
        inside.push(lookahead.next().unwrap_or('^'));
    }
    if lookahead.peek() == Some(&']') {
        inside.push_str("\\]");
        lookahead.next();
    }
    for character in lookahead.by_ref() {
        if character == ']' {
            *characters = lookahead;
            return format!("[{inside}]");
        }
        if matches!(character, '[' | '&' | '~') {
            inside.push('\\');
        }
        inside.push(character);
    }
    "\\[".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn starts(pattern: &str, text: &str) -> Vec<usize> {
        Pattern::parse(pattern, false, false).unwrap().starts_in(text)
    }

    #[test]
    fn plain_text_matches_as_text_and_dot_and_star_are_special() {
        assert_eq!(starts("foo", "foo bar foo"), vec![0, 8]);
        assert_eq!(starts("f.o", "foo fao fo"), vec![0, 4]);
        assert_eq!(starts("fo*", "f fo foo"), vec![0, 2, 5]);
        assert_eq!(starts("^b", "a\nb\nb"), vec![2, 4]);
        assert_eq!(starts("a$", "a\nba\nab"), vec![0, 3]);
    }

    #[test]
    fn brackets_and_plus_and_pipe_are_text_unless_escaped() {
        assert_eq!(starts("a+b", "aab a+b"), vec![4]);
        assert_eq!(starts("a\\+b", "aab a+b"), vec![0]);
        assert_eq!(starts("(x)", "(x) x"), vec![0]);
        assert_eq!(starts("\\(ab\\)\\+", "ababab"), vec![0]);
        assert_eq!(starts("cat\\|dog", "a cat and a dog"), vec![2, 12]);
        assert_eq!(starts("colou\\=r", "color colour"), vec![0, 6]);
        assert_eq!(starts("a\\{2}", "a aa aaa"), vec![2, 5]);
    }

    #[test]
    fn word_edges_and_classes_work() {
        assert_eq!(starts("\\<cat\\>", "cat concat cat"), vec![0, 11]);
        assert_eq!(starts("[0-9]\\+", "a12 b3"), vec![1, 5]);
        assert_eq!(starts("\\d\\d", "1 22 333"), vec![2, 5]);
        assert_eq!(starts("[^a-z]", "ab1"), vec![2]);
        assert_eq!(starts("a[b", "a[b"), vec![0]);
    }

    #[test]
    fn case_is_exact_unless_asked() {
        assert_eq!(starts("foo", "Foo foo"), vec![4]);
        assert_eq!(starts("foo\\c", "Foo foo"), vec![0, 4]);
        assert_eq!(starts("foo\\C", "Foo foo"), vec![4]);
        assert_eq!(Pattern::parse("foo", false, true).unwrap().starts_in("Foo foo"), vec![0, 4]);
    }

    #[test]
    fn whole_words_are_matched_as_text() {
        let word = Pattern::parse("a.b", true, false).unwrap();
        assert_eq!(word.starts_in("a.b xa.b a.b"), vec![0, 9]);
        let dollar = Pattern::parse("$el", true, false).unwrap();
        assert_eq!(dollar.starts_in("$el x$el"), vec![0, 5]);
    }

    #[test]
    fn positions_count_characters_not_bytes() {
        assert_eq!(starts("b", "é😀b"), vec![2]);
    }

    #[test]
    fn a_broken_pattern_is_reported() {
        assert!(Pattern::parse("\\(", false, false).unwrap_err().starts_with("E383"));
    }
}
