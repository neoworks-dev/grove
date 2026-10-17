//! The vim commands that change text in their own ways: putting a register, joining lines,
//! replacing characters, typing over them in replace mode, opening lines and substituting.

use std::time::Instant;

use crate::buffer::{Buffer, Position};
use crate::command::Outcome;
use crate::edit::Edit;
use crate::editing::edited;
use crate::selections::Selection;
use crate::state::EditorState;
use crate::vim::operate::{Covered, covered_text, line_end_offset};
use crate::vim::plan::{CursorSpec, Plan};
use crate::vim::pattern::Pattern;
use crate::vim::registers::{LastSearch, Register};
use crate::vim::types::{LineRange, SelectionKind};

/// The text the system clipboard gives as a register: text ending in a line break is whole lines.
fn register_from_clipboard(text: &str) -> Register {
    match text.strip_suffix('\n') {
        Some(lines) => Register::single(lines.replace("\r\n", "\n"), true),
        None => Register::single(text.replace("\r\n", "\n"), false),
    }
}

/// What each of `count` cursors puts: its own piece when there are as many pieces as cursors,
/// the only piece at every cursor, and otherwise all the pieces, a line each.
fn pieces_for(register: &Register, count: usize) -> Vec<String> {
    if register.texts.len() == count {
        return register.texts.clone();
    }
    if register.texts.len() == 1 {
        return vec![register.texts[0].clone(); count];
    }
    vec![register.joined(); count]
}

/// How many characters of white space a text's first line starts with.
fn leading_space(text: &str) -> usize {
    text.chars().take_while(|character| character.is_whitespace() && *character != '\n').count()
}

/// The plan for putting the lines of a block after or before a cursor: each line goes in its own
/// row, in the same columns, with spaces added where a row is too short and rows added at the end
/// of the text when there are too few.
fn put_block_plan(buffer: &Buffer, head: Position, pieces: &[String], before: bool, count: usize) -> Plan {
    let length = buffer.line_length(head.row);
    let column = if before || length == 0 { head.column } else { (head.column + 1).min(length) };
    let width = pieces.iter().map(|piece| piece.chars().count()).max().unwrap_or(0);
    let mut edits = Vec::new();
    let mut appended = String::new();
    let mut first_padding = 0;
    for (index, piece) in pieces.iter().enumerate() {
        let row = head.row + index;
        let body = piece.repeat(count);
        if row >= buffer.line_count() {
            appended.push('\n');
            appended.push_str(&" ".repeat(column));
            appended.push_str(&body);
            continue;
        }
        let row_length = buffer.line_length(row);
        let line_start = buffer.offset_of(Position { row, column: 0 });
        if row_length < column {
            let padding = " ".repeat(column - row_length);
            if index == 0 {
                first_padding = column - row_length;
            }
            edits.push(Edit::replace(line_start + row_length..line_start + row_length, format!("{padding}{body}")));
            continue;
        }
        let evened = if row_length > column {
            let missing = width.saturating_sub(piece.chars().count());
            format!("{body}{}", " ".repeat(missing))
        } else {
            body
        };
        edits.push(Edit::replace(line_start + column..line_start + column, evened));
    }
    if !appended.is_empty() {
        let end = buffer.length();
        edits.push(Edit::replace(end..end, appended));
    }
    Plan { edits, cursor: CursorSpec::InReplacement { edit: 0, offset: first_padding } }
}

/// The plan for putting text after or before a cursor.
fn put_plan(
    buffer: &Buffer,
    head: Position,
    text: &str,
    linewise: bool,
    before: bool,
    count: usize,
    cursor_after: bool,
) -> Plan {
    if linewise {
        return put_lines_plan(buffer, head.row, text, before, count);
    }
    let head_offset = buffer.offset_of(head);
    let line_end = line_end_offset(buffer, head.row);
    let offset =
        if before || buffer.line_length(head.row) == 0 { head_offset } else { (head_offset + 1).min(line_end) };
    let body = text.repeat(count);
    let length = body.chars().count();
    let cursor_offset = if cursor_after {
        length
    } else if body.contains('\n') {
        0
    } else {
        length.saturating_sub(1)
    };
    Plan::single(Edit::replace(offset..offset, body), CursorSpec::InReplacement { edit: 0, offset: cursor_offset })
}

/// The plan for putting whole lines below a row, or above it.
fn put_lines_plan(buffer: &Buffer, row: usize, text: &str, before: bool, count: usize) -> Plan {
    let last_row = buffer.line_count().saturating_sub(1);
    let indentation = leading_space(text);
    if before {
        let offset = buffer.offset_of(Position { row, column: 0 });
        let body = format!("{text}\n").repeat(count);
        return Plan::single(
            Edit::replace(offset..offset, body),
            CursorSpec::InReplacement { edit: 0, offset: indentation },
        );
    }
    if row < last_row {
        let offset = buffer.offset_of(Position { row: row + 1, column: 0 });
        let body = format!("{text}\n").repeat(count);
        return Plan::single(
            Edit::replace(offset..offset, body),
            CursorSpec::InReplacement { edit: 0, offset: indentation },
        );
    }
    let offset = buffer.length();
    let body = format!("\n{text}").repeat(count);
    Plan::single(Edit::replace(offset..offset, body), CursorSpec::InReplacement { edit: 0, offset: 1 + indentation })
}

/// The plan for replacing what a visual selection covers with a register's text.
fn put_over_plan(covered: Covered, buffer: &Buffer, text: &str, linewise: bool, count: usize) -> Plan {
    let (range, replacement, cursor_offset) = match (covered, linewise) {
        (Covered::Chars { start, end }, false) => {
            let body = text.repeat(count);
            let cursor = body.chars().count().saturating_sub(1);
            (start..end, body, cursor)
        }
        (Covered::Chars { start, end }, true) => (start..end, format!("\n{}\n", text), 1),
        (Covered::Lines { first, last }, true) => {
            let start = buffer.offset_of(Position { row: first, column: 0 });
            (start..line_end_offset(buffer, last), text.to_string(), leading_space(text))
        }
        (Covered::Lines { first, last }, false) => {
            let start = buffer.offset_of(Position { row: first, column: 0 });
            (start..line_end_offset(buffer, last), text.repeat(count), 0)
        }
    };
    Plan::single(Edit::replace(range, replacement), CursorSpec::InReplacement { edit: 0, offset: cursor_offset })
}

impl EditorState {
    /// What a visual selection covers at every cursor.
    fn selected_ranges(&self, kind: SelectionKind) -> Vec<Covered> {
        self.selections
            .all()
            .iter()
            .map(|selection| match kind {
                SelectionKind::Lines => Covered::Lines { first: selection.start().row, last: selection.end().row },
                SelectionKind::Characters | SelectionKind::Block => Covered::Chars {
                    start: self.buffer.offset_of(selection.start()),
                    end: (self.buffer.offset_of(selection.end()) + 1).min(self.buffer.length()),
                },
            })
            .collect()
    }

    /// Puts a register's text at every cursor, or over what is selected.
    pub(crate) fn put(
        &mut self,
        register_name: Option<char>,
        before: bool,
        count: usize,
        cursor_after: bool,
        over: Option<SelectionKind>,
        clipboard: Option<&str>,
        now: Instant,
    ) -> Outcome {
        let register = match clipboard {
            Some(text) => register_from_clipboard(text),
            None => match self.memory.read(register_name) {
                Some(register) => register.clone(),
                None => return Outcome::default(),
            },
        };
        let count = count.max(1);
        let pieces = pieces_for(&register, self.selections.count());
        let plans: Vec<Plan> = match over {
            Some(kind) => {
                let ranges = self.selected_ranges(kind);
                let replaced: Vec<String> = ranges.iter().map(|range| covered_text(&self.buffer, *range)).collect();
                let linewise = matches!(kind, SelectionKind::Lines);
                self.memory.record(None, Register { texts: replaced, linewise, blockwise: false }, false);
                let pairs = ranges.iter().zip(&pieces);
                pairs
                    .map(|(range, piece)| put_over_plan(*range, &self.buffer, piece, register.linewise, count))
                    .collect()
            }
            None if register.blockwise && register.texts.len() > 1 && self.selections.count() == 1 => {
                let head = self.selections.newest().head;
                vec![put_block_plan(&self.buffer, head, &register.texts, before, count)]
            }
            None => {
                let heads = self.selections.all().iter().map(|selection| selection.head);
                let pairs = heads.zip(&pieces);
                let linewise = register.linewise;
                pairs
                    .map(|(head, piece)| put_plan(&self.buffer, head, piece, linewise, before, count, cursor_after))
                    .collect()
            }
        };
        edited(self.commit_plans(plans, true, now))
    }

    /// Joins lines at every cursor.
    pub(crate) fn join_lines(&mut self, count: usize, from_selection: bool, now: Instant) -> Outcome {
        let last_row = self.buffer.line_count().saturating_sub(1);
        let plans: Vec<Plan> = self
            .selections
            .all()
            .iter()
            .map(|selection| {
                let (first, wanted) = if from_selection {
                    (selection.start().row, (selection.end().row - selection.start().row).max(1))
                } else {
                    (selection.head.row, count.max(2) - 1)
                };
                let joins = wanted.min(last_row.saturating_sub(first));
                join_plan(&self.buffer, first, joins, selection.head)
            })
            .collect();
        edited(self.commit_plans(plans, true, now))
    }

    /// Replaces characters with one character at every cursor.
    pub(crate) fn replace_chars(
        &mut self,
        character: char,
        count: usize,
        over: Option<SelectionKind>,
        now: Instant,
    ) -> Outcome {
        let count = count.max(1);
        let plans: Vec<Plan> = match over {
            Some(kind) => self
                .selected_ranges(kind)
                .iter()
                .map(|range| {
                    let original = covered_text(&self.buffer, *range);
                    let text: String =
                        original.chars().map(|each| if each == '\n' { each } else { character }).collect();
                    let start = match range {
                        Covered::Chars { start, .. } => *start,
                        Covered::Lines { first, .. } => self.buffer.offset_of(Position { row: *first, column: 0 }),
                    };
                    let end = start + original.chars().count();
                    Plan::single(Edit::replace(start..end, text), CursorSpec::InReplacement { edit: 0, offset: 0 })
                })
                .collect(),
            None => self
                .selections
                .all()
                .iter()
                .map(|selection| replace_plan(&self.buffer, selection, character, count))
                .collect(),
        };
        edited(self.commit_plans(plans, true, now))
    }

    /// Types text over the characters after each cursor.
    pub(crate) fn overwrite(&mut self, text: &str, now: Instant) -> Outcome {
        let typed = text.chars().count();
        let covered: Vec<(usize, String)> = self
            .selections
            .all()
            .iter()
            .map(|selection| {
                let head = selection.head;
                let available = self.buffer.line_length(head.row).saturating_sub(head.column);
                let start = self.buffer.offset_of(head);
                (typed, self.buffer.slice(start..start + typed.min(available)))
            })
            .collect();
        self.note_overwritten(covered);
        let plans: Vec<Plan> = self
            .selections
            .all()
            .iter()
            .map(|selection| {
                let head = selection.head;
                let available = self.buffer.line_length(head.row).saturating_sub(head.column);
                let start = self.buffer.offset_of(head);
                let edit = Edit::replace(start..start + typed.min(available), text);
                Plan::single(edit, CursorSpec::InReplacement { edit: 0, offset: typed })
            })
            .collect();
        edited(self.commit_plans(plans, false, now))
    }

    /// Opens a line below or above each cursor's line.
    pub(crate) fn open_line(&mut self, above: bool, now: Instant) -> Outcome {
        let mut rows_done: Vec<usize> = Vec::new();
        let plans: Vec<Plan> = self
            .selections
            .all()
            .iter()
            .map(|selection| {
                let row = selection.head.row;
                let indentation: String =
                    self.buffer.line(row).chars().take_while(|character| character.is_whitespace()).collect();
                let length = indentation.chars().count();
                let offset = if above {
                    self.buffer.offset_of(Position { row, column: 0 })
                } else {
                    line_end_offset(&self.buffer, row)
                };
                if rows_done.contains(&row) {
                    return Plan::single(Edit::replace(offset..offset, ""), CursorSpec::AtOldOffset(offset));
                }
                rows_done.push(row);
                if above {
                    return Plan::single(
                        Edit::replace(offset..offset, format!("{indentation}\n")),
                        CursorSpec::InReplacement { edit: 0, offset: length },
                    );
                }
                Plan::single(
                    Edit::replace(offset..offset, format!("\n{indentation}")),
                    CursorSpec::InReplacement { edit: 0, offset: length + 1 },
                )
            })
            .collect();
        edited(self.commit_plans(plans, false, now))
    }

    /// Replaces matches of a pattern, in the lines of a range, with a replacement (see `expand_replacement`).
    pub(crate) fn substitute(
        &mut self,
        range: LineRange,
        pattern: &str,
        replacement: &str,
        global: bool,
        ignore_case: bool,
        now: Instant,
    ) -> Outcome {
        let source = if pattern.is_empty() {
            match &self.memory.last_search {
                Some(last) => last.pattern.clone(),
                None => return error_outcome("E35: No previous regular expression".to_string()),
            }
        } else {
            pattern.to_string()
        };
        let whole_word = pattern.is_empty() && self.memory.last_search.as_ref().is_some_and(|last| last.whole_word);
        let compiled = match Pattern::parse(&source, whole_word, ignore_case) {
            Ok(compiled) => compiled,
            Err(message) => return error_outcome(message),
        };
        self.memory.last_search = Some(LastSearch { pattern: source.clone(), forward: true, whole_word });
        self.memory.search_highlight = true;
        let last_row = self.buffer.line_count().saturating_sub(1);
        let (first, last) = match range {
            LineRange::Current => (self.selections.newest().head.row, self.selections.newest().head.row),
            LineRange::All => (0, last_row),
            LineRange::Selected => {
                let all = self.selections.all();
                (all[0].start().row, all[all.len() - 1].end().row)
            }
        };
        let mut edits = Vec::new();
        let mut last_changed_row = first;
        for row in first..=last.min(last_row) {
            let line_start = self.buffer.offset_of(Position { row, column: 0 });
            let line = self.buffer.line(row);
            let before = edits.len();
            for captures in compiled.regex().captures_iter(&line) {
                let Some(whole) = captures.get(0) else {
                    continue;
                };
                let column = line[..whole.start()].chars().count();
                let length = whole.as_str().chars().count();
                let start = line_start + column;
                edits.push(Edit::replace(start..start + length, expand_replacement(replacement, &captures)));
                if !global {
                    break;
                }
            }
            if edits.len() > before {
                last_changed_row = row;
            }
        }
        if edits.is_empty() {
            return error_outcome(format!("E486: Pattern not found: {source}"));
        }
        let near = self.buffer.offset_of(Position { row: last_changed_row, column: 0 });
        let plan = Plan { edits, cursor: CursorSpec::FirstNonBlankNear(near) };
        edited(self.commit_plans(vec![plan], true, now))
    }
}

/// An outcome that only carries an error message.
fn error_outcome(message: String) -> Outcome {
    Outcome { error: Some(message), ..Outcome::default() }
}

/// What a match is replaced with: `&` is the whole match, `\1` to `\9` are its groups, `\r` is a
/// line break, `\t` a tab, and a backslash before anything else is that character.
fn expand_replacement(replacement: &str, captures: &regex::Captures) -> String {
    let mut text = String::new();
    let mut characters = replacement.chars();
    while let Some(character) = characters.next() {
        match character {
            '&' => text.push_str(captures.get(0).map_or("", |whole| whole.as_str())),
            '\\' => match characters.next() {
                Some(digit @ '0'..='9') => {
                    let group = digit.to_digit(10).unwrap_or(0) as usize;
                    text.push_str(captures.get(group).map_or("", |found| found.as_str()));
                }
                Some('r') => text.push('\n'),
                Some('t') => text.push('\t'),
                Some(other) => text.push(other),
                None => text.push('\\'),
            },
            other => text.push(other),
        }
    }
    text
}

/// The plan for joining a row with the `joins` rows after it.
fn join_plan(buffer: &Buffer, first: usize, joins: usize, head: Position) -> Plan {
    let mut edits = Vec::new();
    for row in first..first + joins {
        let current = buffer.line(row);
        let next = buffer.line(row + 1);
        let leading = next.chars().take_while(|character| character.is_whitespace()).count();
        let next_text: String = next.chars().skip(leading).collect();
        let needs_space = !next_text.is_empty()
            && !current.is_empty()
            && !current.ends_with(char::is_whitespace)
            && !next_text.starts_with(')');
        let start = line_end_offset(buffer, row);
        let end = buffer.offset_of(Position { row: row + 1, column: leading });
        edits.push(Edit::replace(start..end, if needs_space { " " } else { "" }));
    }
    let head_offset = buffer.offset_of(head);
    if edits.is_empty() {
        return Plan::single(Edit::replace(head_offset..head_offset, ""), CursorSpec::AtOldOffset(head_offset));
    }
    let last_edit = edits.len() - 1;
    Plan { edits, cursor: CursorSpec::InReplacement { edit: last_edit, offset: 0 } }
}

/// The plan for replacing `count` characters from a cursor, which only works when that many are left on the line.
fn replace_plan(buffer: &Buffer, selection: &Selection, character: char, count: usize) -> Plan {
    let head = selection.head;
    let head_offset = buffer.offset_of(head);
    let available = buffer.line_length(head.row).saturating_sub(head.column);
    if available < count {
        return Plan::single(Edit::replace(head_offset..head_offset, ""), CursorSpec::AtOldOffset(head_offset));
    }
    if character == '\n' {
        return Plan::single(
            Edit::replace(head_offset..head_offset + count, "\n"),
            CursorSpec::InReplacement { edit: 0, offset: 1 },
        );
    }
    let text: String = std::iter::repeat_n(character, count).collect();
    Plan::single(
        Edit::replace(head_offset..head_offset + count, text),
        CursorSpec::InReplacement { edit: 0, offset: count - 1 },
    )
}
