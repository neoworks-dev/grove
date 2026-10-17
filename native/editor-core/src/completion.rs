//! Accepting a completion: the text goes in at every cursor, extra edits elsewhere go in once,
//! and a snippet leaves its tab stops to be visited with Tab.
//!
//! The text replaces `before` characters before each cursor and `after` characters after it, the
//! same count at every cursor, as the server described the range at the cursor it was asked
//! about. Edits elsewhere in the file, such as an import a completion adds, are given as
//! positions in the text as it is when the completion is accepted.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::anchor::{Anchor, AnchorId, Bias};
use crate::buffer::Position;
use crate::command::{Command, Outcome};
use crate::edit::{Edit, Edits};
use crate::history::{EditKind, Step, Transaction};
use crate::selections::{Selection, Selections};
use crate::snippet::{self, Expanded};
use crate::state::EditorState;

/// A replacement of the text between two positions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RangeEdit {
    pub start: Position,
    pub end: Position,
    pub text: String,
}

/// What accepting a completion does; the fields of `Command::InsertCompletion`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion<'a> {
    pub before: usize,
    pub after: usize,
    pub text: &'a str,
    pub snippet: bool,
    pub additional: &'a [RangeEdit],
}

/// A snippet being tabbed through: the places of each stop, pinned to the text, and which stop
/// the selections are on.
pub(crate) struct SnippetSession {
    stops: Vec<Vec<(AnchorId, AnchorId)>>,
    current: usize,
}

/// Whether a character can be part of a word being completed.
fn is_word_character(character: char) -> bool {
    character.is_alphanumeric() || character == '_' || character == '$'
}

/// Whether a command takes the cursor out of a snippet's stops, so Tab is a tab again.
pub(crate) fn leaves_snippet(command: &Command) -> bool {
    matches!(
        command,
        Command::PlaceCursor { .. }
            | Command::ToggleCursor { .. }
            | Command::CollapseSelections
            | Command::SelectAll
            | Command::Undo
            | Command::Redo
    )
}

/// An edit planned for the completion, and which cursor it belongs to if it is one's own.
struct Planned {
    edit: Edit,
    cursor: Option<usize>,
    expanded: Option<Expanded>,
}

impl EditorState {
    /// Whether a snippet's tab stops are still being visited, so Tab goes to the next one.
    pub fn in_snippet(&self) -> bool {
        self.snippet.is_some()
    }

    /// Accepts a completion at every cursor.
    pub(crate) fn insert_completion(&mut self, completion: &Completion, now: Instant) -> Outcome {
        self.end_snippet();
        let planned = self.plan_completion(completion);
        let edits = Edits::new(planned.iter().map(|planned| planned.edit.clone()).collect());
        if edits.is_noop() {
            return Outcome::default();
        }
        let selections_before = self.selections.clone();
        let inverse = self.replace_text(&edits);
        let replacements = edits.replacement_ranges();
        let (selections, session) = self.after_completion(&planned, &replacements);
        self.selections = selections;
        self.snippet = session;
        let revision_before = self.revision;
        self.next_revision += 1;
        self.revision = self.next_revision;
        let transaction = Transaction {
            steps: vec![Step { edits, inverse }],
            selections_before,
            selections_after: self.selections.clone(),
            revision_before,
            revision_after: self.revision,
        };
        self.history.record(transaction, EditKind::Other, now);
        Outcome { text_changed: true, reveal_newest: true, changed: true, ..Outcome::default() }
    }

    /// Moves to the snippet's next stop, and ends the snippet at the last. Does nothing outside one.
    pub(crate) fn snippet_next(&mut self) -> Outcome {
        let Some(session) = &self.snippet else {
            return Outcome::default();
        };
        let next = session.current + 1;
        if next >= session.stops.len() {
            self.end_snippet();
            return Outcome::default();
        }
        self.visit_stop(next)
    }

    /// Moves back to the snippet's previous stop.
    pub(crate) fn snippet_previous(&mut self) -> Outcome {
        let Some(session) = &self.snippet else {
            return Outcome::default();
        };
        if session.current == 0 {
            return Outcome::default();
        }
        let previous = session.current - 1;
        self.visit_stop(previous)
    }

    /// Stops visiting a snippet's stops and lets go of the anchors that held them.
    pub(crate) fn end_snippet(&mut self) {
        let Some(session) = self.snippet.take() else {
            return;
        };
        for (start, end) in session.stops.into_iter().flatten() {
            self.anchors.remove(start);
            self.anchors.remove(end);
        }
    }

    /// One edit for each cursor, and the extra ones, in the order of the text.
    fn plan_completion(&self, completion: &Completion) -> Vec<Planned> {
        let buffer = &self.buffer;
        let mut planned = Vec::new();
        let newest = self.selections.newest_index();
        for (index, selection) in self.selections.all().iter().enumerate() {
            let head = buffer.offset_of(selection.head);
            let mut before = completion.before;
            if index != newest {
                before = self.replaceable_before(head, before);
            }
            let start = head.saturating_sub(before);
            let end = (head + completion.after).min(buffer.length());
            let (text, expanded) = self.completion_text(completion, selection);
            planned.push(Planned { edit: Edit::replace(start..end, text), cursor: Some(index), expanded });
        }
        for extra in completion.additional {
            let edit = Edit::replace(buffer.offset_of(extra.start)..buffer.offset_of(extra.end), extra.text.clone());
            planned.push(Planned { edit, cursor: None, expanded: None });
        }
        planned.sort_by_key(|planned| (planned.edit.start, planned.edit.end));
        planned
    }

    /// How many of the `before` characters before an offset another cursor replaces. The count
    /// was worked out at the newest cursor; where this cursor has less of the same word before it,
    /// only that is replaced, so a cursor that had typed `co` beside one that had typed `cons`
    /// does not eat what comes before its word.
    fn replaceable_before(&self, offset: usize, before: usize) -> usize {
        let available = offset.min(before);
        let window = self.buffer.slice(offset - available..offset);
        let word_characters = window.chars().rev().take_while(|character| is_word_character(*character)).count();
        if word_characters == window.chars().count() {
            return available;
        }
        word_characters
    }

    /// The text one cursor gets: the snippet expanded to the indentation of the cursor's line,
    /// or the text as it is.
    fn completion_text(&self, completion: &Completion, selection: &Selection) -> (String, Option<Expanded>) {
        if !completion.snippet || snippet::is_plain(completion.text) {
            return (self.unescaped_if_snippet(completion), None);
        }
        let line = self.buffer.line(selection.head.row);
        let indentation: String = line.chars().take_while(|character| character.is_whitespace()).collect();
        let expanded = snippet::expand(completion.text, &indentation);
        (expanded.text.clone(), Some(expanded))
    }

    /// The text of a completion with nothing to tab through. Snippet syntax that only escapes
    /// characters is still unescaped.
    fn unescaped_if_snippet(&self, completion: &Completion) -> String {
        if !completion.snippet {
            return completion.text.to_string();
        }
        snippet::expand(completion.text, "").text
    }

    /// The selections once the completion is in, and the session when a snippet has stops: a
    /// cursor after each cursor's text, or the snippet's first stop everywhere.
    fn after_completion(
        &mut self,
        planned: &[Planned],
        replacements: &[std::ops::Range<usize>],
    ) -> (Selections, Option<SnippetSession>) {
        let newest = self.selections.newest_index();
        let mut cursors: Vec<(usize, usize, Option<&Expanded>)> = Vec::new();
        for (planned, replacement) in planned.iter().zip(replacements) {
            if let Some(cursor) = planned.cursor {
                cursors.push((cursor, replacement.start, planned.expanded.as_ref()));
            }
        }
        cursors.sort_by_key(|(cursor, _, _)| *cursor);
        let has_stops =
            cursors.iter().any(|(_, _, expanded)| expanded.is_some_and(|expanded| !expanded.stops.is_empty()));
        if !has_stops {
            let ends = planned.iter().zip(replacements).filter(|(planned, _)| planned.cursor.is_some());
            let list =
                ends.map(|(_, replacement)| Selection::cursor(self.buffer.position_of(replacement.end))).collect();
            return (Selections::from_list(list, newest), None);
        }
        let session = self.pin_snippet_stops(&cursors);
        let session = SnippetSession { current: 0, ..session };
        let selections = self.selections_on_stop(&session, newest);
        (selections, Some(session))
    }

    /// Pins every place of every stop, in every cursor's copy of the snippet, to the text.
    fn pin_snippet_stops(&mut self, cursors: &[(usize, usize, Option<&Expanded>)]) -> SnippetSession {
        let mut stops: Vec<Vec<(AnchorId, AnchorId)>> = Vec::new();
        let longest = cursors.iter().filter_map(|(_, _, expanded)| expanded.map(|e| e.stops.len())).max();
        for stop_position in 0..longest.unwrap_or(0) {
            let mut anchors = Vec::new();
            for (_, text_start, expanded) in cursors {
                let Some(stop) = expanded.and_then(|expanded| expanded.stops.get(stop_position)) else {
                    continue;
                };
                for place in &stop.places {
                    let start = self.anchors.insert(Anchor { offset: text_start + place.start, bias: Bias::Left });
                    let end = self.anchors.insert(Anchor { offset: text_start + place.end, bias: Bias::Right });
                    anchors.push((start, end));
                }
            }
            stops.push(anchors);
        }
        SnippetSession { stops, current: 0 }
    }

    /// Selects every place of the session's current stop.
    fn selections_on_stop(&self, session: &SnippetSession, newest: usize) -> Selections {
        let mut list = Vec::new();
        for (start, end) in &session.stops[session.current] {
            let start = self.anchors.get(*start).map(|anchor| anchor.offset);
            let end = self.anchors.get(*end).map(|anchor| anchor.offset);
            let (Some(start), Some(end)) = (start, end) else {
                continue;
            };
            list.push(Selection::spanning(self.buffer.position_of(start), self.buffer.position_of(end.max(start))));
        }
        if list.is_empty() {
            return self.selections.clone();
        }
        list.sort_by_key(|selection| selection.start());
        Selections::from_list(list, newest.min(self.selections.count() - 1))
    }

    /// Selects the places of one stop, and ends the snippet when it is the last.
    fn visit_stop(&mut self, stop: usize) -> Outcome {
        let Some(mut session) = self.snippet.take() else {
            return Outcome::default();
        };
        session.current = stop;
        let newest = self.selections.newest_index();
        self.selections = self.selections_on_stop(&session, newest);
        let last = stop + 1 == session.stops.len();
        self.snippet = Some(session);
        if last {
            self.end_snippet();
        }
        Outcome { changed: true, reveal_newest: true, ..Outcome::default() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffer::Buffer;
    use crate::command::Command;

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    fn state(text: &str) -> EditorState {
        EditorState::new(Buffer::from_text(text))
    }

    fn accept(state: &mut EditorState, before: usize, text: &str, snippet: bool) {
        let command =
            Command::InsertCompletion { before, after: 0, text: text.to_string(), snippet, additional: Vec::new() };
        state.apply(&command);
    }

    fn text(state: &EditorState) -> String {
        state.buffer().slice(0..state.buffer().length())
    }

    #[test]
    fn plain_text_replaces_the_typed_prefix_at_every_cursor() {
        let mut state = state("con\ncon\n");
        state.apply(&Command::PlaceCursor { at: at(0, 3) });
        state.apply(&Command::ToggleCursor { at: at(1, 3) });
        accept(&mut state, 3, "const", false);
        assert_eq!(text(&state), "const\nconst\n");
        let heads: Vec<_> = state.selections().all().iter().map(|selection| selection.head).collect();
        assert_eq!(heads, vec![at(0, 5), at(1, 5)]);
    }

    #[test]
    fn a_cursor_with_less_typed_replaces_only_its_own_word() {
        let mut state = state("a con\ncons\n  \n");
        state.apply(&Command::PlaceCursor { at: at(0, 5) });
        state.apply(&Command::ToggleCursor { at: at(2, 2) });
        state.apply(&Command::ToggleCursor { at: at(1, 4) });
        accept(&mut state, 4, "console", false);
        assert_eq!(text(&state), "a console\nconsole\n  console\n");
    }

    #[test]
    fn extra_edits_elsewhere_go_in_once_and_the_cursor_follows_the_text() {
        let mut state = state("use a;\n\nfoo");
        state.apply(&Command::PlaceCursor { at: at(2, 3) });
        let command = Command::InsertCompletion {
            before: 3,
            after: 0,
            text: "foobar".into(),
            snippet: false,
            additional: vec![RangeEdit { start: at(0, 0), end: at(0, 0), text: "use b;\n".into() }],
        };
        state.apply(&command);
        assert_eq!(text(&state), "use b;\nuse a;\n\nfoobar");
        assert_eq!(state.selections().newest().head, at(3, 6));
        state.apply(&Command::Undo);
        assert_eq!(text(&state), "use a;\n\nfoo");
    }

    #[test]
    fn a_snippet_selects_its_first_stop_and_tab_visits_the_rest() {
        let mut state = state("pr");
        state.apply(&Command::PlaceCursor { at: at(0, 2) });
        accept(&mut state, 2, "println!(${1:text}, $2)$0", true);
        assert_eq!(text(&state), "println!(text, )");
        assert!(state.in_snippet());
        assert_eq!(state.selections().newest(), Selection::spanning(at(0, 9), at(0, 13)));
        state.apply(&Command::SnippetNext);
        assert_eq!(state.selections().newest(), Selection::cursor(at(0, 15)));
        state.apply(&Command::SnippetNext);
        assert_eq!(state.selections().newest(), Selection::cursor(at(0, 16)));
        assert!(!state.in_snippet());
    }

    #[test]
    fn typing_over_a_placeholder_keeps_the_later_stops_in_place() {
        let mut state = state("");
        accept(&mut state, 0, "f(${1:alpha}, ${2:beta})", true);
        state.apply(&Command::InsertText { text: "x".into() });
        state.apply(&Command::SnippetNext);
        assert_eq!(text(&state), "f(x, beta)");
        assert_eq!(state.selections().newest(), Selection::spanning(at(0, 5), at(0, 9)));
    }

    #[test]
    fn every_cursor_gets_the_snippet_and_the_stops_select_together() {
        let mut state = state("a\nb\n");
        state.apply(&Command::PlaceCursor { at: at(0, 1) });
        state.apply(&Command::ToggleCursor { at: at(1, 1) });
        accept(&mut state, 0, "(${1:x})", true);
        assert_eq!(text(&state), "a(x)\nb(x)\n");
        assert_eq!(state.selections().count(), 2);
        state.apply(&Command::InsertText { text: "yy".into() });
        assert_eq!(text(&state), "a(yy)\nb(yy)\n");
    }

    #[test]
    fn a_function_call_snippet_leaves_every_cursor_between_its_parentheses() {
        let mut state = state("gre\ngre\n");
        state.apply(&Command::PlaceCursor { at: at(0, 3) });
        state.apply(&Command::ToggleCursor { at: at(1, 3) });
        accept(&mut state, 3, "greet($0)", true);
        assert_eq!(text(&state), "greet()\ngreet()\n");
        let heads: Vec<_> = state.selections().all().iter().map(|selection| selection.head).collect();
        assert_eq!(heads, vec![at(0, 6), at(1, 6)]);
        state.apply(&Command::InsertText { text: "x".into() });
        assert_eq!(text(&state), "greet(x)\ngreet(x)\n");
    }

    #[test]
    fn mirrored_stops_are_typed_into_together() {
        let mut state = state("");
        accept(&mut state, 0, "${1:name}: $1", true);
        state.apply(&Command::InsertText { text: "id".into() });
        assert_eq!(text(&state), "id: id");
    }

    #[test]
    fn later_lines_of_a_snippet_follow_the_indentation() {
        let mut state = state("    if");
        state.apply(&Command::PlaceCursor { at: at(0, 6) });
        accept(&mut state, 2, "if $1 {\n\t$0\n}", true);
        assert_eq!(text(&state), "    if  {\n    \t\n    }");
    }

    #[test]
    fn leaving_the_snippet_ends_it_and_frees_its_anchors() {
        let mut state = state("");
        accept(&mut state, 0, "${1:a} ${2:b}", true);
        assert!(state.anchor_count() > 0);
        state.apply(&Command::CollapseSelections);
        assert!(!state.in_snippet());
        assert_eq!(state.anchor_count(), 0);
    }

    #[test]
    fn a_snippet_without_stops_is_just_text() {
        let mut state = state("x");
        state.apply(&Command::PlaceCursor { at: at(0, 1) });
        accept(&mut state, 1, r"foo\$bar", true);
        assert_eq!(text(&state), "foo$bar");
        assert!(!state.in_snippet());
    }
}
