//! The state of the completion panel and the decisions that need no window: when typing opens
//! it, how the text typed since narrows its items, and what accepting an item changes.

use std::collections::HashMap;

use editor_core::{AnchorId, Buffer, DocumentId, Position, RangeEdit, Utf16Point};
use lsp_client::completion::{self, Item, Match};

use crate::lsp::Pending;

/// How many rows the panel shows at once.
pub const VISIBLE_ROWS: usize = 10;

/// What opened the panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    /// Typing a word.
    Typing,
    /// A character the server asked to be told about.
    Character(char),
    /// Ctrl-Space.
    Invoked,
}

/// A panel that is open, or about to be: the request is out and the items have not come yet.
pub struct Session {
    pub document: DocumentId,
    /// Pinned where the text the items replace starts, so it follows edits made before it.
    pub start: AnchorId,
    pub trigger: Trigger,
    pub items: Vec<Item>,
    /// Whether the server wants asking again as the word grows.
    pub is_incomplete: bool,
    pub matches: Vec<Match>,
    /// The index in `matches` of the selected row.
    pub selected: usize,
    /// The index in `matches` of the first row shown.
    pub first_visible: usize,
    /// The text typed since `start`, which the items are filtered by.
    pub query: String,
    /// The number of the request whose answer is wanted, and the request itself.
    pub request: u64,
    pub pending: Option<Pending>,
    /// The items resolved for more documentation, and the requests still out, by item index.
    pub resolved: Vec<usize>,
    pub resolving: HashMap<u64, usize>,
}

impl Session {
    /// A session whose first answer is awaited.
    pub fn new(document: DocumentId, start: AnchorId, trigger: Trigger, request: u64, pending: Pending) -> Session {
        Session {
            document,
            start,
            trigger,
            items: Vec::new(),
            is_incomplete: false,
            matches: Vec::new(),
            selected: 0,
            first_visible: 0,
            query: String::new(),
            request,
            pending: Some(pending),
            resolved: Vec::new(),
            resolving: HashMap::new(),
        }
    }

    /// Whether there is anything to show.
    pub fn is_visible(&self) -> bool {
        !self.matches.is_empty()
    }

    /// Narrows the items to those that match `query`, keeping the selected item selected if it still matches.
    pub fn filter(&mut self, query: &str) {
        let selected_item = self.selected_index();
        self.query = query.to_string();
        self.matches = completion::filter(&self.items, query);
        self.selected = 0;
        self.first_visible = 0;
        if let Some(item) = selected_item {
            if let Some(position) = self.matches.iter().position(|found| found.index == item) {
                self.select(position);
            }
        }
        if self.selected_index().is_none() {
            return;
        }
        let preselected = self.matches.iter().position(|found| self.items[found.index].preselect);
        if let (Some(position), true) = (preselected, selected_item.is_none()) {
            self.select(position);
        }
    }

    /// The index in `items` of the selected item.
    pub fn selected_index(&self) -> Option<usize> {
        self.matches.get(self.selected).map(|found| found.index)
    }

    /// The selected item.
    pub fn selected_item(&self) -> Option<&Item> {
        self.items.get(self.selected_index()?)
    }

    /// Selects the row at an index of `matches`, scrolling the panel to show it.
    pub fn select(&mut self, position: usize) {
        if self.matches.is_empty() {
            return;
        }
        self.selected = position.min(self.matches.len() - 1);
        if self.selected < self.first_visible {
            self.first_visible = self.selected;
        }
        if self.selected >= self.first_visible + VISIBLE_ROWS {
            self.first_visible = self.selected + 1 - VISIBLE_ROWS;
        }
    }

    /// Moves the selection by some rows, wrapping around the ends when it moves by one.
    pub fn move_selection(&mut self, rows: isize) {
        if self.matches.is_empty() {
            return;
        }
        let last = self.matches.len() as isize - 1;
        let target = self.selected as isize + rows;
        let target = if target < 0 && rows.abs() == 1 {
            last
        } else if target > last && rows.abs() == 1 {
            0
        } else {
            target.clamp(0, last)
        };
        self.select(target as usize);
    }
}

/// Whether a character can be part of a word being completed.
pub fn is_word_character(character: char) -> bool {
    character.is_alphanumeric() || character == '_' || character == '$'
}

/// The column where the word that ends at `column` starts.
pub fn word_start(line: &str, column: usize) -> usize {
    let characters: Vec<char> = line.chars().collect();
    let mut start = column.min(characters.len());
    while start > 0 && is_word_character(characters[start - 1]) {
        start -= 1;
    }
    start
}

/// Whether typing a word character should open the panel: the word is a name, not a number.
pub fn word_opens_panel(line: &str, column: usize) -> bool {
    let start = word_start(line, column);
    match line.chars().nth(start) {
        Some(first) => start < column && !first.is_ascii_digit(),
        None => false,
    }
}

/// Whether text typed since the start of a completion has left the word: anything but word
/// characters ends it.
pub fn query_ends_session(query: &str) -> bool {
    !query.chars().all(is_word_character)
}

/// What accepting an item does to the text, as the arguments of `Command::InsertCompletion`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Acceptance {
    pub before: usize,
    pub after: usize,
    pub text: String,
    pub snippet: bool,
    pub additional: Vec<RangeEdit>,
}

/// Works out what accepting an item changes, with the cursor at `head` and the text the panel
/// replaces starting at `start`. The item's own range is used when it is on the cursor's line,
/// stretched to the cursor if more was typed since the server answered.
pub fn plan_acceptance(buffer: &Buffer, head: Position, start: Position, item: &Item) -> Acceptance {
    let head_offset = buffer.offset_of(head);
    let (from, to) = replaced_offsets(buffer, head, start, item);
    let from = from.min(head_offset);
    let text = match &item.edit {
        Some(edit) => edit.new_text.clone(),
        None => item.insert_text.clone(),
    };
    Acceptance {
        before: head_offset - from,
        after: to.saturating_sub(head_offset),
        text,
        snippet: item.is_snippet,
        additional: additional_edits(buffer, item),
    }
}

/// The offsets of the text an item replaces.
fn replaced_offsets(buffer: &Buffer, head: Position, start: Position, item: &Item) -> (usize, usize) {
    let head_offset = buffer.offset_of(head);
    let Some(edit) = &item.edit else {
        return (buffer.offset_of(start), head_offset);
    };
    if edit.range.start.line != head.row || edit.range.end.line != head.row {
        return (buffer.offset_of(start), head_offset);
    }
    (offset_of(buffer, edit.range.start), offset_of(buffer, edit.range.end))
}

/// The edits an item makes elsewhere, in the buffer's positions.
fn additional_edits(buffer: &Buffer, item: &Item) -> Vec<RangeEdit> {
    let position_of = |position: lsp_client::protocol::Position| buffer.position_of(offset_of(buffer, position));
    item.additional_edits
        .iter()
        .map(|edit| RangeEdit {
            start: position_of(edit.range.start),
            end: position_of(edit.range.end),
            text: edit.new_text.clone(),
        })
        .collect()
}

/// The offset of a server's position in the buffer.
fn offset_of(buffer: &Buffer, position: lsp_client::protocol::Position) -> usize {
    buffer.offset_of_utf16_point(Utf16Point { line: position.line, character: position.character })
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_core::{Bias, EditorState};
    use lsp_client::completion::{ItemEdit, parse_item};
    use lsp_client::protocol::{Position as LspPosition, Range, TextEdit};
    use serde_json::{Value, json};

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    fn item(label: &str) -> Item {
        parse_item(&json!({ "label": label }), &Value::Null).unwrap()
    }

    fn range(line: usize, start: usize, end: usize) -> Range {
        Range {
            start: LspPosition { line, character: start },
            end: LspPosition { line, character: end },
        }
    }

    #[test]
    fn words_start_where_name_characters_begin() {
        assert_eq!(word_start("  foo.barBaz", 12), 6);
        assert_eq!(word_start("  foo.barBaz", 5), 2);
        assert_eq!(word_start("$el_1", 5), 0);
        assert_eq!(word_start("", 0), 0);
    }

    #[test]
    fn numbers_and_empty_words_do_not_open_the_panel() {
        assert!(word_opens_panel("let fo", 6));
        assert!(!word_opens_panel("let 12", 6));
        assert!(!word_opens_panel("let ", 4));
        assert!(word_opens_panel("a1", 2));
    }

    #[test]
    fn leaving_the_word_ends_the_session() {
        assert!(!query_ends_session("foo_1"));
        assert!(!query_ends_session(""));
        assert!(query_ends_session("foo "));
        assert!(query_ends_session("a.b"));
    }

    #[test]
    fn an_items_own_edit_decides_what_is_replaced() {
        let buffer = Buffer::from_text("x.al\n");
        let mut found = item("alpha");
        found.edit = Some(ItemEdit { range: range(0, 2, 4), new_text: "alpha".into() });
        let plan = plan_acceptance(&buffer, at(0, 4), at(0, 2), &found);
        assert_eq!((plan.before, plan.after, plan.text.as_str()), (2, 0, "alpha"));
    }

    #[test]
    fn text_typed_after_the_answer_is_replaced_too() {
        let buffer = Buffer::from_text("x.alph\n");
        let mut found = item("alpha");
        found.edit = Some(ItemEdit { range: range(0, 2, 4), new_text: "alpha".into() });
        let plan = plan_acceptance(&buffer, at(0, 6), at(0, 2), &found);
        assert_eq!((plan.before, plan.after), (4, 0));
    }

    #[test]
    fn a_replace_range_past_the_cursor_takes_the_rest_of_the_word() {
        let buffer = Buffer::from_text("x.alXY\n");
        let mut found = item("alpha");
        found.edit = Some(ItemEdit { range: range(0, 2, 6), new_text: "alpha".into() });
        let plan = plan_acceptance(&buffer, at(0, 4), at(0, 2), &found);
        assert_eq!((plan.before, plan.after), (2, 2));
    }

    #[test]
    fn an_item_without_an_edit_replaces_the_typed_word() {
        let buffer = Buffer::from_text("  con\n");
        let mut found = item("console");
        found.insert_text = "console".into();
        let plan = plan_acceptance(&buffer, at(0, 5), at(0, 2), &found);
        assert_eq!((plan.before, plan.after, plan.text.as_str()), (3, 0, "console"));
        assert!(!plan.snippet);
    }

    #[test]
    fn columns_are_converted_from_utf16() {
        let buffer = Buffer::from_text("😀.al\n");
        let mut found = item("alpha");
        found.edit = Some(ItemEdit { range: range(0, 3, 5), new_text: "alpha".into() });
        let plan = plan_acceptance(&buffer, at(0, 4), at(0, 2), &found);
        assert_eq!(plan.before, 2);
    }

    #[test]
    fn additional_edits_are_positioned_in_the_buffer() {
        let buffer = Buffer::from_text("a😀b\nx\n");
        let mut found = item("foo");
        found.additional_edits = vec![TextEdit { range: range(0, 3, 4), new_text: "Q".into() }];
        let plan = plan_acceptance(&buffer, at(1, 1), at(1, 0), &found);
        assert_eq!(plan.additional, vec![RangeEdit { start: at(0, 2), end: at(0, 3), text: "Q".into() }]);
    }

    fn session_with(items: Vec<Item>) -> Session {
        let mut session = Session {
            document: 1,
            start: EditorState::new(Buffer::from_text("")).create_anchor(at(0, 0), Bias::Left),
            trigger: Trigger::Typing,
            items,
            is_incomplete: false,
            matches: Vec::new(),
            selected: 0,
            first_visible: 0,
            query: String::new(),
            request: 1,
            pending: None,
            resolved: Vec::new(),
            resolving: HashMap::new(),
        };
        session.filter("");
        session
    }

    #[test]
    fn the_selection_wraps_and_keeps_itself_in_view() {
        let items: Vec<Item> = (0..25).map(|number| item(&format!("item{number:02}"))).collect();
        let mut session = session_with(items);
        session.move_selection(-1);
        assert_eq!((session.selected, session.first_visible), (24, 15));
        session.move_selection(1);
        assert_eq!((session.selected, session.first_visible), (0, 0));
        session.move_selection(8);
        session.move_selection(8);
        assert_eq!((session.selected, session.first_visible), (16, 7));
        session.move_selection(-50);
        assert_eq!(session.selected, 0);
    }

    #[test]
    fn filtering_keeps_the_selected_item_while_it_still_matches() {
        let mut session = session_with(vec![item("alpha"), item("beta"), item("gamma")]);
        session.select(2);
        let selected = session.selected_item().unwrap().label.clone();
        session.filter("a");
        assert_eq!(session.selected_item().unwrap().label, selected);
        session.filter("zzz");
        assert!(!session.is_visible());
        assert!(session.selected_item().is_none());
    }
}
