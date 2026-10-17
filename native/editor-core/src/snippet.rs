//! Snippets: text with places to tab through, in the syntax language servers use for completions.
//!
//! `$1`, `${1}` and `${1:placeholder}` are tab stops; `$0` is where the cursor ends up. A
//! placeholder may hold more snippet text, a choice `${1|one,two|}` stands for its first entry,
//! and a variable such as `$TM_FILENAME` stands for its default text, or for nothing. `\$`,
//! `\}` and `\\` are those characters. A tab stop that appears several times is a mirror: every
//! occurrence is one of its places, and since all of them are selected together, typing in one
//! types in all.

/// One place a snippet can be tabbed to: the characters `start..end` of the expanded text. An
/// empty range is a plain cursor position.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Place {
    pub start: usize,
    pub end: usize,
}

/// All the places of one tab stop, which are selected together.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabStop {
    pub index: u32,
    pub places: Vec<Place>,
}

/// A snippet with its tab stops resolved against the text they sit in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Expanded {
    /// The text to insert.
    pub text: String,
    /// The stops in the order Tab visits them: ascending, with `$0` last. A snippet without
    /// `$0` ends with one at the end of the text.
    pub stops: Vec<TabStop>,
}

/// Parses snippet text. Text that is not valid snippet syntax is kept as written, so a stray
/// `$` or `}` never loses what the server meant to insert. `indentation` is put after every line
/// break of a multi-line snippet, so it lines up with the line it is inserted in.
pub fn expand(snippet: &str, indentation: &str) -> Expanded {
    let characters: Vec<char> = snippet.chars().collect();
    let mut parser = Parser { characters: &characters, position: 0, text: String::new(), places: Vec::new() };
    parser.parse_until(None);
    let Parser { text, places, .. } = parser;
    let (text, places) = indent_lines(&text, places, indentation);
    Expanded { text, stops: group_into_stops(places) }
}

/// A place found while parsing, before its stop is known to have others.
struct FoundPlace {
    index: u32,
    place: Place,
}

struct Parser<'a> {
    characters: &'a [char],
    position: usize,
    /// The expanded text so far.
    text: String,
    places: Vec<FoundPlace>,
}

impl Parser<'_> {
    /// Reads text and stops until `end` (the `}` of a placeholder) or the end of the input. The
    /// closing character is left unread.
    fn parse_until(&mut self, end: Option<char>) {
        while let Some(&character) = self.characters.get(self.position) {
            if Some(character) == end {
                return;
            }
            self.position += 1;
            match character {
                '\\' => self.parse_escape(),
                '$' => self.parse_dollar(),
                other => self.text.push(other),
            }
        }
    }

    /// A backslash: it escapes `$`, `}` and `\`, and is itself otherwise.
    fn parse_escape(&mut self) {
        match self.characters.get(self.position) {
            Some(&escaped) if matches!(escaped, '$' | '}' | '\\') => {
                self.text.push(escaped);
                self.position += 1;
            }
            _ => self.text.push('\\'),
        }
    }

    /// What follows a `$`: a stop, a placeholder, a variable, or just a dollar sign.
    fn parse_dollar(&mut self) {
        let Some(&next) = self.characters.get(self.position) else {
            self.text.push('$');
            return;
        };
        if next == '{' {
            self.position += 1;
            self.parse_braced();
            return;
        }
        if next.is_ascii_digit() {
            let index = self.read_number();
            self.add_place(index, self.here(), self.here());
            return;
        }
        if is_variable_start(next) {
            self.read_name();
            return;
        }
        self.text.push('$');
    }

    /// The inside of `${…}`: a number or a name, then nothing, `:default` or `|choices|`.
    fn parse_braced(&mut self) {
        let start = self.position;
        let Some(&first) = self.characters.get(self.position) else {
            self.text.push_str("${");
            return;
        };
        if first.is_ascii_digit() {
            let index = self.read_number();
            self.parse_stop_body(index, start);
            return;
        }
        if is_variable_start(first) {
            self.read_name();
            self.parse_variable_body(start);
            return;
        }
        self.text.push_str("${");
    }

    /// What follows the number of a `${1…}`.
    fn parse_stop_body(&mut self, index: u32, start: usize) {
        match self.characters.get(self.position) {
            Some('}') => {
                self.position += 1;
                self.add_place(index, self.here(), self.here());
            }
            Some(':') => {
                self.position += 1;
                let from = self.here();
                self.parse_until(Some('}'));
                self.close_brace();
                self.add_place(index, from, self.here());
            }
            Some('|') => {
                self.position += 1;
                let from = self.here();
                self.parse_choice();
                self.add_place(index, from, self.here());
            }
            _ => self.give_up(start),
        }
    }

    /// What follows the name of a `${NAME…}`: the text of its default, if it has one.
    fn parse_variable_body(&mut self, start: usize) {
        match self.characters.get(self.position) {
            Some('}') => self.position += 1,
            Some(':') => {
                self.position += 1;
                self.parse_until(Some('}'));
                self.close_brace();
            }
            _ => self.give_up(start),
        }
    }

    /// A choice list, `a,b,c|}`, of which the first entry is inserted.
    fn parse_choice(&mut self) {
        let mut first = true;
        while let Some(&character) = self.characters.get(self.position) {
            self.position += 1;
            if character == '|' {
                if self.characters.get(self.position) == Some(&'}') {
                    self.position += 1;
                }
                return;
            }
            if character == ',' {
                first = false;
                continue;
            }
            if character == '\\' && self.characters.get(self.position).is_some() {
                let escaped = self.characters[self.position];
                self.position += 1;
                if first {
                    self.text.push(escaped);
                }
                continue;
            }
            if first {
                self.text.push(character);
            }
        }
    }

    /// Reads the `}` that ends a placeholder, if the input has one.
    fn close_brace(&mut self) {
        if self.characters.get(self.position) == Some(&'}') {
            self.position += 1;
        }
    }

    /// Writes out syntax that turned out not to be a stop, as it was written.
    fn give_up(&mut self, start: usize) {
        self.text.push_str("${");
        let written: String = self.characters[start..self.position].iter().collect();
        self.text.push_str(&written);
    }

    /// Reads a run of digits.
    fn read_number(&mut self) -> u32 {
        let mut value: u32 = 0;
        while let Some(digit) = self.characters.get(self.position).and_then(|character| character.to_digit(10)) {
            value = value.saturating_mul(10).saturating_add(digit);
            self.position += 1;
        }
        value
    }

    /// Reads a variable name, which stands for nothing in the text.
    fn read_name(&mut self) {
        while self.characters.get(self.position).is_some_and(|character| is_variable_part(*character)) {
            self.position += 1;
        }
    }

    /// How many characters of text there are so far.
    fn here(&self) -> usize {
        self.text.chars().count()
    }

    /// Records a place of a stop.
    fn add_place(&mut self, index: u32, start: usize, end: usize) {
        self.places.push(FoundPlace { index, place: Place { start, end } });
    }
}

/// Whether a character can start a variable name.
fn is_variable_start(character: char) -> bool {
    character.is_ascii_alphabetic() || character == '_'
}

/// Whether a character can be inside a variable name.
fn is_variable_part(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

/// Puts `indentation` after every line break, moving the places along with the text.
fn indent_lines(text: &str, mut places: Vec<FoundPlace>, indentation: &str) -> (String, Vec<FoundPlace>) {
    if indentation.is_empty() || !text.contains('\n') {
        return (text.to_string(), places);
    }
    let indentation_length = indentation.chars().count();
    let mut indented = String::with_capacity(text.len() + indentation.len());
    let mut breaks_before: Vec<usize> = Vec::new();
    for (offset, character) in text.chars().enumerate() {
        indented.push(character);
        if character == '\n' {
            indented.push_str(indentation);
            breaks_before.push(offset + 1);
        }
    }
    let shifted = |offset: usize| offset + indentation_length * breaks_before.iter().filter(|b| **b <= offset).count();
    for found in &mut places {
        found.place = Place { start: shifted(found.place.start), end: shifted(found.place.end) };
    }
    (indented, places)
}

/// Collects places into stops in tabbing order: ascending, `$0` last, and an end stop made up if
/// the snippet has none.
fn group_into_stops(places: Vec<FoundPlace>) -> Vec<TabStop> {
    let mut stops: Vec<TabStop> = Vec::new();
    for found in places {
        match stops.iter_mut().find(|stop| stop.index == found.index) {
            Some(stop) => stop.places.push(found.place),
            None => stops.push(TabStop { index: found.index, places: vec![found.place] }),
        }
    }
    stops.sort_by_key(|stop| if stop.index == 0 { u32::MAX } else { stop.index });
    stops
}

/// Whether a snippet has anything to tab through. A snippet that is plain text can be inserted
/// as it is.
pub fn is_plain(snippet: &str) -> bool {
    !snippet.contains('$') && !snippet.contains('\\')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stops_of(snippet: &str) -> Vec<(u32, Vec<(usize, usize)>)> {
        let expanded = expand(snippet, "");
        expanded
            .stops
            .iter()
            .map(|stop| (stop.index, stop.places.iter().map(|place| (place.start, place.end)).collect()))
            .collect()
    }

    #[test]
    fn plain_text_has_no_stops() {
        let expanded = expand("just text", "");
        assert_eq!(expanded.text, "just text");
        assert!(expanded.stops.is_empty());
        assert!(is_plain("just text"));
        assert!(!is_plain("a$1"));
    }

    #[test]
    fn numbered_stops_come_in_order_and_the_zero_stop_last() {
        let expanded = expand("fn $1($2) { $0 }", "");
        assert_eq!(expanded.text, "fn () {  }");
        assert_eq!(stops_of("fn $1($2) { $0 }"), vec![(1, vec![(3, 3)]), (2, vec![(4, 4)]), (0, vec![(8, 8)])]);
    }

    #[test]
    fn placeholders_are_text_that_is_selected() {
        let expanded = expand("for ${1:item} in ${2:items} {}", "");
        assert_eq!(expanded.text, "for item in items {}");
        assert_eq!(stops_of("for ${1:item} in ${2:items} {}"), vec![(1, vec![(4, 8)]), (2, vec![(12, 17)])]);
    }

    #[test]
    fn placeholders_may_hold_other_stops() {
        let stops = stops_of("${1:a ${2:b} c}");
        assert_eq!(expand("${1:a ${2:b} c}", "").text, "a b c");
        assert_eq!(stops, vec![(1, vec![(0, 5)]), (2, vec![(2, 3)])]);
    }

    #[test]
    fn a_choice_inserts_its_first_entry() {
        let expanded = expand("let ${1|mut,ref|} x", "");
        assert_eq!(expanded.text, "let mut x");
        assert_eq!(expanded.stops[0].places[0], Place { start: 4, end: 7 });
    }

    #[test]
    fn variables_stand_for_their_default_or_nothing() {
        assert_eq!(expand("a $TM_FILENAME b ${TM_LINE_INDEX:7} c ${UNKNOWN}", "").text, "a  b 7 c ");
    }

    #[test]
    fn mirrors_are_places_of_one_stop() {
        assert_eq!(stops_of("${1:x} = $1;"), vec![(1, vec![(0, 1), (4, 4)])]);
    }

    #[test]
    fn escapes_and_stray_dollars_are_kept() {
        assert_eq!(expand(r"\$1 costs $ and \} \\ \n", "").text, "$1 costs $ and } \\ \\n");
        assert_eq!(expand("${", "").text, "${");
        assert_eq!(expand("${1", "").text, "${1");
        assert!(expand(r"\$1", "").stops.is_empty());
    }

    #[test]
    fn later_lines_take_the_indentation_and_the_stops_move_with_them() {
        let expanded = expand("if $1 {\n\t$2\n}", "  ");
        assert_eq!(expanded.text, "if  {\n  \t\n  }");
        let places: Vec<_> = expanded.stops.iter().map(|stop| stop.places[0].start).collect();
        assert_eq!(places, vec![3, 9]);
    }

    #[test]
    fn characters_not_bytes_are_counted() {
        assert_eq!(stops_of("é${1:ü}$0"), vec![(1, vec![(1, 2)]), (0, vec![(2, 2)])]);
    }
}
