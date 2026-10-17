//! Jump labels, as flash.nvim has them: the person types a few characters, every match of them in
//! view gets a one or two letter label, and typing a label puts the cursor there. This is the
//! session a view keeps while that is going on. It works out the matches and the labels from the
//! text; the view paints them and feeds it keys.
//!
//! A label never starts with a character that could be the next one of the pattern, so a key is
//! either a label or more of the pattern and never both.

use std::collections::HashSet;
use std::ops::Range;

use crate::buffer::{Buffer, Position};
use crate::command::Command;

/// The characters labels are made of, with the home row first so the nearest matches are the
/// easiest to type.
pub const LABEL_ALPHABET: &str = "asdfghjklqwertyuiopzxcvbnm";

/// The most matches looked for, which keeps a one letter pattern from labelling a whole screen of
/// minified text.
const MAX_MATCHES: usize = 2000;

/// One place the pattern matches in view.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JumpMatch {
    /// Where the match starts, which is where a jump to it lands.
    pub start: Position,
    /// How many characters it covers.
    pub length: usize,
    /// What to type to jump to it, if it has a label.
    pub label: Option<String>,
}

/// A key a jump session understands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JumpKey {
    Character(char),
    Backspace,
    /// Jumps to the nearest match.
    Enter,
    Escape,
}

/// What a key did to the session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JumpStep {
    /// The session goes on, with the matches and labels as they are now.
    Continue,
    /// The session is over, and the cursor goes here.
    Jump(Position),
    /// The session is over without a jump.
    Cancel,
}

/// A jump in progress.
#[derive(Clone, Debug)]
pub struct JumpSession {
    /// The command to run when a place is chosen, with a placeholder where the place goes.
    then: Command,
    /// Where the cursor was when the jump began, which the labels are ranked by.
    origin: Position,
    /// The rows that are in view, and the only ones searched.
    rows: Range<usize>,
    pattern: String,
    /// The first character of a two letter label, once it has been typed.
    typed_label: String,
    matches: Vec<JumpMatch>,
}

impl JumpSession {
    /// A session over the rows in view that runs `then` with the place that is chosen.
    pub fn new(then: Command, origin: Position, rows: Range<usize>) -> Self {
        JumpSession { then, origin, rows, pattern: String::new(), typed_label: String::new(), matches: Vec::new() }
    }

    /// What has been typed to search for.
    pub fn pattern(&self) -> &str {
        &self.pattern
    }

    /// The first character of a two letter label that has been typed, or empty.
    pub fn typed_label(&self) -> &str {
        &self.typed_label
    }

    /// Every match in view, nearest the cursor first.
    pub fn matches(&self) -> &[JumpMatch] {
        &self.matches
    }

    /// The command to run for a jump to `at`.
    pub fn command_for(&self, at: Position) -> Command {
        self.then.with_jump_target(at)
    }

    /// Takes a key: a label jumps, other characters narrow the search, Backspace takes one back,
    /// Enter jumps to the nearest match and Escape ends the session.
    pub fn press(&mut self, buffer: &Buffer, key: JumpKey) -> JumpStep {
        match key {
            JumpKey::Escape => JumpStep::Cancel,
            JumpKey::Enter => match self.matches.first() {
                Some(nearest) => JumpStep::Jump(nearest.start),
                None => JumpStep::Cancel,
            },
            JumpKey::Backspace => self.take_back(buffer),
            JumpKey::Character(character) => self.type_character(buffer, character),
        }
    }

    /// Undoes the last typed key: the half typed label, else the last character of the pattern.
    fn take_back(&mut self, buffer: &Buffer) -> JumpStep {
        if !self.typed_label.is_empty() {
            self.typed_label.clear();
            return JumpStep::Continue;
        }
        if self.pattern.pop().is_none() {
            return JumpStep::Cancel;
        }
        self.search(buffer);
        JumpStep::Continue
    }

    /// A character is part of a label when one of the matches has it, and else more of the pattern.
    fn type_character(&mut self, buffer: &Buffer, character: char) -> JumpStep {
        let typed = format!("{}{character}", self.typed_label);
        if let Some(chosen) = self.matches.iter().find(|candidate| candidate.label.as_deref() == Some(typed.as_str())) {
            return JumpStep::Jump(chosen.start);
        }
        let continues_a_label = self.matches.iter().any(|candidate| {
            candidate.label.as_ref().is_some_and(|label| label.len() > typed.len() && label.starts_with(&typed))
        });
        if continues_a_label {
            self.typed_label = typed;
            return JumpStep::Continue;
        }
        if !self.typed_label.is_empty() {
            self.typed_label.clear();
            return JumpStep::Continue;
        }
        self.pattern.push(character);
        self.search(buffer);
        JumpStep::Continue
    }

    /// Finds the matches of the pattern in view and labels them.
    fn search(&mut self, buffer: &Buffer) {
        self.typed_label.clear();
        self.matches = find_matches(buffer, self.rows.clone(), &self.pattern);
        let following = following_characters(buffer, &self.matches, &self.pattern);
        rank_by_distance(&mut self.matches, self.origin);
        assign_labels(&mut self.matches, &following);
    }
}

/// Whether a pattern is searched without regard to case: when it has no capital letters.
fn ignores_case(pattern: &str) -> bool {
    !pattern.chars().any(char::is_uppercase)
}

/// The same letter whatever its case, for matching.
fn folded(character: char) -> char {
    character.to_lowercase().next().unwrap_or(character)
}

/// Every place `pattern` appears in `rows`, left to right and top to bottom, none overlapping.
pub fn find_matches(buffer: &Buffer, rows: Range<usize>, pattern: &str) -> Vec<JumpMatch> {
    let wanted: Vec<char> = pattern.chars().collect();
    if wanted.is_empty() {
        return Vec::new();
    }
    let ignore_case = ignores_case(pattern);
    let mut matches = Vec::new();
    for row in rows.start..rows.end.min(buffer.line_count()) {
        let line: Vec<char> = buffer.line(row).chars().collect();
        let mut column = 0;
        while column + wanted.len() <= line.len() {
            if !matches_at(&line, column, &wanted, ignore_case) {
                column += 1;
                continue;
            }
            matches.push(JumpMatch { start: Position { row, column }, length: wanted.len(), label: None });
            column += wanted.len();
            if matches.len() >= MAX_MATCHES {
                return matches;
            }
        }
    }
    matches
}

/// Whether the characters of `wanted` are the ones of `line` from `column` on.
fn matches_at(line: &[char], column: usize, wanted: &[char], ignore_case: bool) -> bool {
    wanted.iter().enumerate().all(|(offset, character)| {
        let found = line[column + offset];
        found == *character || ignore_case && folded(found) == folded(*character)
    })
}

/// The characters that come right after the matches, which a label must not start with because
/// typing one would make the pattern longer.
fn following_characters(buffer: &Buffer, matches: &[JumpMatch], pattern: &str) -> HashSet<char> {
    let ignore_case = ignores_case(pattern);
    let mut following = HashSet::new();
    for found in matches {
        let line = buffer.line(found.start.row);
        let Some(next) = line.chars().nth(found.start.column + found.length) else {
            continue;
        };
        following.insert(if ignore_case { folded(next) } else { next });
    }
    following
}

/// Orders matches by how far they are from the cursor: by rows first, then by columns.
fn rank_by_distance(matches: &mut [JumpMatch], origin: Position) {
    matches.sort_by_key(|found| (found.start.row.abs_diff(origin.row), found.start.column.abs_diff(origin.column)));
}

/// Gives the nearest matches (the first of `matches`) one letter labels and the rest two letter
/// ones, using no character in `following`. Matches there are no labels left for stay unlabelled.
pub fn assign_labels(matches: &mut [JumpMatch], following: &HashSet<char>) {
    let available: Vec<char> = LABEL_ALPHABET.chars().filter(|character| !following.contains(character)).collect();
    for found in matches.iter_mut() {
        found.label = None;
    }
    let letters = available.len();
    if letters == 0 {
        return;
    }
    let prefixes = prefixes_needed(matches.len(), letters);
    let singles = letters - prefixes;
    for (index, found) in matches.iter_mut().enumerate() {
        if index < singles {
            found.label = Some(available[index].to_string());
            continue;
        }
        let pair = index - singles;
        let (prefix, second) = (pair / letters, pair % letters);
        if prefix >= prefixes {
            break;
        }
        found.label = Some(format!("{}{}", available[singles + prefix], available[second]));
    }
}

/// How many letters have to give up being labels themselves, to start two letter labels, for
/// `count` matches to be labelled with `letters` letters. None when one letter labels are enough.
fn prefixes_needed(count: usize, letters: usize) -> usize {
    if count <= letters {
        return 0;
    }
    for prefixes in 1..letters {
        if letters - prefixes + prefixes * letters >= count {
            return prefixes;
        }
    }
    letters.saturating_sub(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::movement::Motion;

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    fn session(text: &str, origin: Position) -> (Buffer, JumpSession) {
        let buffer = Buffer::from_text(text);
        let then = Command::MoveSelections { motion: Motion::To(Position::default()), extend: false };
        let session = JumpSession::new(then, origin, 0..buffer.line_count());
        (buffer, session)
    }

    fn type_text(session: &mut JumpSession, buffer: &Buffer, text: &str) -> JumpStep {
        let mut step = JumpStep::Continue;
        for character in text.chars() {
            step = session.press(buffer, JumpKey::Character(character));
        }
        step
    }

    #[test]
    fn typed_characters_find_every_match_in_view() {
        let buffer = Buffer::from_text("foo bar foo\nxfoo\nbaz");
        let found = find_matches(&buffer, 0..3, "foo");
        let starts: Vec<Position> = found.iter().map(|found| found.start).collect();
        assert_eq!(starts, vec![at(0, 0), at(0, 8), at(1, 1)]);
        assert_eq!(found[0].length, 3);
    }

    #[test]
    fn only_the_rows_in_view_are_searched() {
        let buffer = Buffer::from_text("a\na\na\na");
        assert_eq!(find_matches(&buffer, 1..3, "a").len(), 2);
    }

    #[test]
    fn a_pattern_without_capitals_ignores_case_and_one_with_them_does_not() {
        let buffer = Buffer::from_text("Foo foo FOO");
        assert_eq!(find_matches(&buffer, 0..1, "foo").len(), 3);
        assert_eq!(find_matches(&buffer, 0..1, "Foo").len(), 1);
    }

    #[test]
    fn matches_do_not_overlap() {
        let buffer = Buffer::from_text("aaaa");
        assert_eq!(find_matches(&buffer, 0..1, "aa").len(), 2);
    }

    #[test]
    fn the_nearest_matches_get_the_first_labels() {
        let (buffer, mut jump) = session("x\nx\nx\nx\nx", at(3, 0));
        type_text(&mut jump, &buffer, "x");
        let labelled: Vec<(Position, &str)> =
            jump.matches().iter().map(|found| (found.start, found.label.as_deref().unwrap())).collect();
        assert_eq!(labelled[0], (at(3, 0), "a"));
        assert_eq!(labelled[1].1, "s");
        assert_eq!(labelled.len(), 5);
        let distances: Vec<usize> = jump.matches().iter().map(|found| found.start.row.abs_diff(3)).collect();
        assert_eq!(distances, vec![0, 1, 1, 2, 3]);
    }

    #[test]
    fn a_label_is_never_the_character_after_a_match() {
        let (buffer, mut jump) = session("fa fs fd", at(0, 0));
        type_text(&mut jump, &buffer, "f");
        let labels: Vec<&str> = jump.matches().iter().map(|found| found.label.as_deref().unwrap()).collect();
        assert_eq!(labels, vec!["f", "g", "h"]);
    }

    #[test]
    fn typing_a_label_jumps_to_its_match() {
        let (buffer, mut jump) = session("one two\nthree two", at(0, 0));
        type_text(&mut jump, &buffer, "two");
        let target = jump.matches().iter().find(|found| found.start == at(1, 6)).unwrap();
        let label = target.label.clone().unwrap();
        assert_eq!(type_text(&mut jump, &buffer, &label), JumpStep::Jump(at(1, 6)));
    }

    #[test]
    fn many_matches_get_two_letter_labels_and_the_prefix_is_remembered() {
        let text = "x\n".repeat(60);
        let (buffer, mut jump) = session(&text, at(0, 0));
        type_text(&mut jump, &buffer, "x");
        let labels: Vec<&str> = jump.matches().iter().map(|found| found.label.as_deref().unwrap()).collect();
        assert!(labels.iter().any(|label| label.len() == 1));
        assert!(labels.iter().any(|label| label.len() == 2));
        let unique: HashSet<&&str> = labels.iter().collect();
        assert_eq!(unique.len(), labels.len());
        let two =
            jump.matches().iter().find(|found| found.label.as_ref().is_some_and(|label| label.len() == 2)).unwrap();
        let (label, start) = (two.label.clone().unwrap(), two.start);
        let first = label.chars().next().unwrap();
        assert_eq!(jump.press(&buffer, JumpKey::Character(first)), JumpStep::Continue);
        assert_eq!(jump.typed_label(), first.to_string());
        let second = label.chars().nth(1).unwrap();
        assert_eq!(jump.press(&buffer, JumpKey::Character(second)), JumpStep::Jump(start));
    }

    #[test]
    fn single_letter_labels_are_never_the_start_of_a_longer_label() {
        let text = "x\n".repeat(80);
        let (buffer, mut jump) = session(&text, at(0, 0));
        type_text(&mut jump, &buffer, "x");
        let singles: HashSet<char> = jump
            .matches()
            .iter()
            .filter_map(|found| found.label.as_deref().filter(|label| label.len() == 1))
            .map(|label| label.chars().next().unwrap())
            .collect();
        for found in jump.matches() {
            let label = found.label.as_deref().unwrap_or("");
            if label.len() == 2 {
                assert!(!singles.contains(&label.chars().next().unwrap()));
            }
        }
    }

    #[test]
    fn matches_beyond_the_labels_stay_unlabelled() {
        let mut matches: Vec<JumpMatch> =
            (0..800).map(|row| JumpMatch { start: at(row, 0), length: 1, label: None }).collect();
        assign_labels(&mut matches, &HashSet::new());
        assert!(matches[0].label.is_some());
        assert!(matches[799].label.is_none());
    }

    #[test]
    fn enter_jumps_to_the_nearest_match_and_escape_ends_the_session() {
        let (buffer, mut jump) = session("x\nab\nx", at(2, 0));
        assert_eq!(jump.press(&buffer, JumpKey::Enter), JumpStep::Cancel);
        type_text(&mut jump, &buffer, "x");
        assert_eq!(jump.press(&buffer, JumpKey::Enter), JumpStep::Jump(at(2, 0)));
        assert_eq!(jump.press(&buffer, JumpKey::Escape), JumpStep::Cancel);
    }

    #[test]
    fn backspace_takes_back_a_character_and_ends_the_session_when_there_is_none() {
        let (buffer, mut jump) = session("foo fob", at(0, 0));
        type_text(&mut jump, &buffer, "foo");
        assert_eq!(jump.matches().len(), 1);
        jump.press(&buffer, JumpKey::Backspace);
        assert_eq!(jump.pattern(), "fo");
        assert_eq!(jump.matches().len(), 2);
        jump.press(&buffer, JumpKey::Backspace);
        jump.press(&buffer, JumpKey::Backspace);
        assert!(jump.matches().is_empty());
        assert_eq!(jump.press(&buffer, JumpKey::Backspace), JumpStep::Cancel);
    }

    #[test]
    fn the_jump_runs_its_command_with_the_chosen_place() {
        let (_, jump) = session("a", at(0, 0));
        let command = jump.command_for(at(3, 4));
        assert_eq!(command, Command::MoveSelections { motion: Motion::To(at(3, 4)), extend: false });
    }

    #[test]
    fn a_character_that_is_no_label_goes_on_the_pattern_even_with_matches_showing() {
        let (buffer, mut jump) = session("fa fs fd", at(0, 0));
        type_text(&mut jump, &buffer, "f");
        // 'a' follows a match, so it is not a label and extends the pattern.
        jump.press(&buffer, JumpKey::Character('a'));
        assert_eq!(jump.pattern(), "fa");
        assert_eq!(jump.matches().len(), 1);
    }
}
