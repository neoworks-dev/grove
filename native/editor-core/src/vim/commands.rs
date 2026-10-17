//! Carrying out vim's commands on the editor state: moving, searching, selecting and the
//! rest that do not change text. The ones that do are in `operate` and `changes`.

use std::time::Instant;

use crate::anchor::Bias;
use crate::buffer::Position;
use crate::command::{Command, Outcome};
use crate::selections::Selection;
use crate::state::EditorState;
use crate::vim::motion::{first_non_blank_column, reach};
use crate::vim::objects::{ObjectRange, find_object};
use crate::vim::plan::clamp_to_line;
use crate::vim::search::search_landing;
use crate::vim::types::SearchRequest;

impl EditorState {
    /// Carries out one of vim's commands.
    pub(crate) fn run_vim(&mut self, command: &Command, now: Instant) -> Outcome {
        match command {
            Command::Fail { message } => Outcome { error: Some(message.clone()), ..Outcome::default() },
            Command::Request { request } => Outcome { request: Some(request.clone()), ..Outcome::default() },
            Command::VimMove { motion, count, extend } => {
                self.vim_move(*motion, *count, *extend);
                Outcome { reveal_newest: true, ..Outcome::default() }
            }
            Command::Operate { operator, target, register } => self.operate(*operator, target, *register, now),
            Command::Put { register, before, count, cursor_after, over, clipboard } => {
                self.put(*register, *before, *count, *cursor_after, *over, clipboard.as_deref(), now)
            }
            Command::JoinLines { count, from_selection } => self.join_lines(*count, *from_selection, now),
            Command::ReplaceChars { character, count, over } => self.replace_chars(*character, *count, *over, now),
            Command::Overwrite { text } => self.overwrite(text, now),
            Command::OpenLine { above } => self.open_line(*above, now),
            Command::Substitute { range, pattern, replacement, global, ignore_case } => {
                self.substitute(*range, pattern, replacement, *global, *ignore_case, now)
            }
            Command::VimSearch { request, count, extend } => self.vim_search(request, *count, *extend),
            Command::SelectObject { object, around, count } => self.select_object(*object, *around, *count),
            Command::SwapSelectionEnds => {
                self.selections.transform(|selection| Selection {
                    anchor: selection.head,
                    head: selection.anchor,
                    goal_column: None,
                });
                Outcome { reveal_newest: true, ..Outcome::default() }
            }
            Command::SelectNextMatch { add } => self.select_next_match(*add),
            Command::CollapseToHeads => {
                self.collapse_to_heads();
                Outcome::default()
            }
            Command::ClampCursors => {
                self.clamp_cursors();
                Outcome::default()
            }
            Command::GroupUndo { open } => {
                if *open {
                    self.overwritten.clear();
                    self.history.hold();
                } else {
                    self.history.release();
                }
                Outcome::default()
            }
            Command::ScrollTo { align } => Outcome { scroll: Some(*align), ..Outcome::default() },
            Command::BlockStart => self.block_start(),
            Command::BlockMove { motion, count } => self.block_move(*motion, *count),
            Command::BlockSwap => self.block_swap(),
            Command::BlockEnd { exit } => self.block_end(*exit),
            Command::BlockInsert { append } => self.block_insert(*append),
            Command::ClearSearchHighlight => {
                self.memory.search_highlight = false;
                Outcome::default()
            }
            Command::RememberVisual { kind } => {
                self.remember_visual(*kind);
                Outcome::default()
            }
            Command::ReselectVisual => self.reselect_visual(),
            Command::SelectLastExtent => self.select_last_extent(),
            Command::PushJump => {
                self.push_jump();
                Outcome::default()
            }
            Command::JumpOlder { count } => self.jump_older(*count),
            Command::JumpNewer { count } => self.jump_newer(*count),
            Command::RestoreOverwritten => self.restore_overwritten(now),
            Command::ScrollView { rows } => Outcome { scroll_rows: Some(*rows), ..Outcome::default() },
            Command::SetMark { name } => {
                self.set_mark(*name);
                Outcome::default()
            }
            Command::JumpToMark { name, linewise, extend } => self.jump_to_mark(*name, *linewise, *extend),
            _ => Outcome::default(),
        }
    }

    /// Moves every head by a motion, keeping it on a character of its line.
    fn vim_move(&mut self, motion: crate::movement::Motion, count: usize, extend: bool) {
        let buffer = &self.buffer;
        self.selections.transform(|selection| {
            let Some(reached) = reach(buffer, selection, motion, count, false) else {
                return *selection;
            };
            let head = clamp_to_line(buffer, reached.position);
            let anchor = if extend { selection.anchor } else { head };
            Selection { anchor, head, goal_column: reached.goal_column }
        });
    }

    /// Collapses every selection to a cursor at its head, on a character of its line.
    fn collapse_to_heads(&mut self) {
        let buffer = &self.buffer;
        self.selections.transform(|selection| Selection::cursor(clamp_to_line(buffer, selection.head)));
    }

    /// Selects the word under the newest cursor, or adds the next place the newest selection's
    /// text occurs. A selection ends on its last character, as in visual mode.
    fn select_next_match(&mut self, add: bool) -> Outcome {
        let newest = self.selections.newest();
        let last_character = |end: Position| Position { row: end.row, column: end.column.saturating_sub(1) };
        if !add {
            let Some(word) = crate::movement::word_at(&self.buffer, newest.head) else {
                return Outcome::default();
            };
            self.selections.replace_newest(Selection::spanning(word.start(), last_character(word.end())));
            return Outcome { reveal_newest: true, ..Outcome::default() };
        }
        let end = Position { row: newest.end().row, column: newest.end().column + 1 };
        let needle = self.buffer.text_between(newest.start(), end);
        let Some(found) = crate::movement::find_next(&self.buffer, &needle, end) else {
            return Outcome::default();
        };
        self.selections.add(Selection::spanning(found.start(), last_character(found.end())));
        Outcome { reveal_newest: true, ..Outcome::default() }
    }

    /// Moves every head back onto a character of its line.
    fn clamp_cursors(&mut self) {
        let buffer = &self.buffer;
        self.selections.transform(|selection| {
            let head = clamp_to_line(buffer, selection.head);
            let anchor = if selection.is_empty() { head } else { selection.anchor };
            Selection { anchor, head, goal_column: selection.goal_column }
        });
    }

    /// Moves every cursor to where a search finds its match.
    fn vim_search(&mut self, request: &SearchRequest, count: usize, extend: bool) -> Outcome {
        let mut found_any = false;
        let mut heads = Vec::new();
        for selection in self.selections.all().to_vec() {
            let landing = search_landing(&self.buffer, &mut self.memory, &selection, request, count);
            match landing {
                Some(offset) => {
                    found_any = true;
                    heads.push(self.buffer.position_of(offset));
                }
                None => heads.push(selection.head),
            }
        }
        if !found_any {
            return Outcome { error: Some(self.search_failure(request)), ..Outcome::default() };
        }
        let mut heads = heads.into_iter();
        self.selections.transform(|selection| {
            let head = heads.next().unwrap_or(selection.head);
            let anchor = if extend { selection.anchor } else { head };
            Selection { anchor, head, goal_column: None }
        });
        Outcome { reveal_newest: true, ..Outcome::default() }
    }

    /// The message for a search that found nothing.
    fn search_failure(&self, request: &SearchRequest) -> String {
        match (request, &self.memory.last_search) {
            (SearchRequest::Pattern { pattern, .. }, _) => format!("E486: Pattern not found: {pattern}"),
            (_, Some(last)) => format!("E486: Pattern not found: {}", last.pattern),
            (_, None) => "E35: No previous regular expression".to_string(),
        }
    }

    /// Selects the text object at every cursor, with the head on its last character.
    fn select_object(&mut self, object: crate::vim::types::TextObject, around: bool, count: usize) -> Outcome {
        let buffer = &self.buffer;
        self.selections.transform(|selection| {
            let Some(range) = find_object(buffer, selection.head, object, around, count) else {
                return *selection;
            };
            match range {
                ObjectRange::Chars { start, end } => {
                    let last = end.saturating_sub(1).max(start);
                    Selection::spanning(buffer.position_of(start), buffer.position_of(last))
                }
                ObjectRange::Lines { first, last } => {
                    let end_column = buffer.line_length(last).saturating_sub(1);
                    Selection::spanning(Position { row: first, column: 0 }, Position { row: last, column: end_column })
                }
            }
        });
        Outcome { reveal_newest: true, ..Outcome::default() }
    }

    /// Pins the newest cursor's place under a name.
    fn set_mark(&mut self, name: char) {
        let at = self.selections.newest().head;
        if let Some(old) = self.marks.remove(&name) {
            self.anchors.remove(old);
        }
        let anchor = self.create_anchor(at, Bias::Left);
        self.marks.insert(name, anchor);
    }

    /// Goes to a marked place, or to the first non-blank of its line.
    fn jump_to_mark(&mut self, name: char, linewise: bool, extend: bool) -> Outcome {
        let Some(anchor) = self.marks.get(&name).copied() else {
            return Outcome { error: Some(format!("E20: Mark not set: {name}")), ..Outcome::default() };
        };
        let Some(mut target) = self.anchor_position(anchor) else {
            return Outcome::default();
        };
        if linewise {
            target.column = first_non_blank_column(&self.buffer.line(target.row));
        }
        let target = clamp_to_line(&self.buffer, target);
        let selection = self.selections.newest();
        let anchor_position = if extend { selection.anchor } else { target };
        self.selections.replace_newest(Selection { anchor: anchor_position, head: target, goal_column: None });
        Outcome { reveal_newest: true, ..Outcome::default() }
    }
}
