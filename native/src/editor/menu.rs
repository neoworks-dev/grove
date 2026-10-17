//! The lists the editor shows for the places a symbol is used (references, implementations) and
//! for the actions a server offers at the cursor. Both are a list of rows to move through and
//! pick from: references are shown as a picker in the middle of the view with a preview of the
//! code around the selected place, actions as a menu at the cursor.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use editor_core::{DocumentId, Position};
use lsp_client::actions::{self, CodeAction};
use lsp_client::edits::WorkspaceEdit;
use lsp_client::protocol::{Range, ResponseError, Target};
use lsp_client::uri::path_from_uri;
use serde_json::{Value, json};
use svelte_gpui::gpui::{Context, Keystroke};

use super::features::FeatureSignal;
use super::{Editor, SharedDocuments, Signal};
use crate::lsp::Pending;

/// How many rows a list shows at once.
pub const MENU_ROWS: usize = 10;

/// How many lines of code are shown above and below the selected reference.
const PREVIEW_CONTEXT: usize = 3;

/// The code around a place, to show beside the list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preview {
    /// The line number, counted from zero, of the first line.
    pub first_line: usize,
    pub lines: Vec<String>,
    /// Which of the lines is the place itself, and the characters of it that the place covers.
    pub focus: usize,
    pub columns: (usize, usize),
}

/// A place in a file, read for the list: where it is, the line it is on, and the code around it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocationItem {
    pub path: PathBuf,
    pub line: usize,
    pub character: usize,
    pub text: String,
    pub preview: Preview,
}

/// What choosing a row does.
#[derive(Clone, Debug)]
pub enum MenuAction {
    Open { path: PathBuf, line: usize, character: usize },
    Run(Box<CodeAction>),
}

/// One row of a list.
#[derive(Clone, Debug)]
pub struct MenuRow {
    pub title: String,
    /// Dim text after the title: the code of a place, or what kind of action it is.
    pub detail: String,
    pub preview: Option<Preview>,
    /// Why the row cannot be chosen, when it cannot.
    pub disabled: Option<String>,
    pub action: MenuAction,
}

/// What a list is of, which decides where it is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuKind {
    Locations,
    CodeActions,
}

/// A list that is showing, or whose rows are awaited.
pub struct Menu {
    pub kind: MenuKind,
    pub title: String,
    pub document: DocumentId,
    pub request: u64,
    pub pending: Option<Pending>,
    pub rows: Vec<MenuRow>,
    pub selected: usize,
    pub first_visible: usize,
}

impl Menu {
    /// Whether there are rows to show yet.
    pub fn is_visible(&self) -> bool {
        !self.rows.is_empty()
    }

    /// The row that is selected.
    pub fn selected_row(&self) -> Option<&MenuRow> {
        self.rows.get(self.selected)
    }

    /// Moves the selection by some rows, wrapping round the ends when it moves by one.
    pub fn move_selection(&mut self, rows: isize) {
        if self.rows.is_empty() {
            return;
        }
        let last = self.rows.len() as isize - 1;
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

    /// Selects a row, scrolling the list to show it.
    pub fn select(&mut self, row: usize) {
        if self.rows.is_empty() {
            return;
        }
        self.selected = row.min(self.rows.len() - 1);
        if self.selected < self.first_visible {
            self.first_visible = self.selected;
        }
        if self.selected >= self.first_visible + MENU_ROWS {
            self.first_visible = self.selected + 1 - MENU_ROWS;
        }
    }
}

/// Reads the places for a list: the line each is on and the code around it. Files are read once;
/// an open document's own text is used, so what is shown is what the person sees.
pub fn location_items(documents: &SharedDocuments, targets: &[Target]) -> Vec<LocationItem> {
    let mut files: HashMap<PathBuf, Option<Vec<String>>> = HashMap::new();
    let mut items = Vec::new();
    for target in targets {
        let Some(path) = path_from_uri(&target.uri) else {
            continue;
        };
        let lines = files.entry(path.clone()).or_insert_with(|| read_lines(documents, &path));
        let line = target.range.start.line;
        let (text, preview) = match lines {
            Some(lines) => (trimmed_line(lines, line), preview_of(lines, line, &target.range)),
            None => (String::new(), Preview { first_line: line, lines: Vec::new(), focus: 0, columns: (0, 0) }),
        };
        items.push(LocationItem { path, line, character: target.range.start.character, text, preview });
    }
    items
}

/// The lines of a file, from the open document if there is one, else from the disk.
fn read_lines(documents: &SharedDocuments, path: &Path) -> Option<Vec<String>> {
    let open = {
        let documents = documents.lock();
        let id = documents.find_by_path(path);
        id.and_then(|id| documents.get(id)).map(|document| document.state.buffer().rope().to_string())
    };
    let text = match open {
        Some(text) => text,
        None => std::fs::read_to_string(path).ok()?,
    };
    Some(text.lines().map(str::to_string).collect())
}

/// A line without its leading white space, cut short.
fn trimmed_line(lines: &[String], line: usize) -> String {
    let text = lines.get(line).map(|text| text.trim()).unwrap_or_default();
    text.chars().take(160).collect()
}

/// The lines around a place.
fn preview_of(lines: &[String], line: usize, range: &Range) -> Preview {
    let first = line.saturating_sub(PREVIEW_CONTEXT);
    let last = (line + PREVIEW_CONTEXT + 1).min(lines.len());
    let shown: Vec<String> = lines[first.min(lines.len())..last].iter().map(|text| clip(text)).collect();
    let end = if range.end.line == line { range.end.character } else { range.start.character };
    Preview { first_line: first, lines: shown, focus: line - first, columns: (range.start.character, end) }
}

/// A line cut to a length a preview can show.
fn clip(text: &str) -> String {
    text.chars().take(200).collect()
}

/// The part of the paths that all of them share, up to the last directory, which is left off
/// when the paths are shown.
pub fn common_directory(paths: &[&Path]) -> PathBuf {
    let Some(first) = paths.first() else {
        return PathBuf::new();
    };
    let mut common: PathBuf = first.parent().map(Path::to_path_buf).unwrap_or_default();
    for path in &paths[1..] {
        while !path.starts_with(&common) {
            if !common.pop() {
                return PathBuf::new();
            }
        }
    }
    common
}

impl Editor {
    /// Asks where the symbol at the cursor is used, and lists the places.
    pub(super) fn find_references(&mut self, cx: &mut Context<Self>) {
        let (Some(document), Some(head)) = (self.document, self.cursor()) else {
            return;
        };
        if !self.lsp.capabilities(document).is_some_and(|capabilities| capabilities.references) {
            self.notice("This language server cannot find references");
            return;
        }
        let request = self.start_menu("References", MenuKind::Locations, document, cx);
        let sender = self.signals.clone();
        let documents = self.documents.clone();
        let reply = Box::new(move |result: Result<Value, ResponseError>| {
            let targets = match result {
                Ok(answer) => lsp_client::protocol::parse_targets(&answer),
                Err(_) => Vec::new(),
            };
            let items = location_items(&documents, &targets);
            let _ = sender.unbounded_send(Signal::Feature(FeatureSignal::Locations { request, items }));
        });
        let extra = json!({ "context": { "includeDeclaration": true } });
        let pending = self.lsp.request_at(document, head, "textDocument/references", extra, reply);
        self.menu_pending(request, pending);
    }

    /// Opens a list that waits for its rows, closing the one that was open.
    fn start_menu(&mut self, title: &str, kind: MenuKind, document: DocumentId, cx: &mut Context<Self>) -> u64 {
        self.close_menu();
        self.close_signature();
        let request = self.next_request_number();
        self.features.menu = Some(Menu {
            kind,
            title: title.to_string(),
            document,
            request,
            pending: None,
            rows: Vec::new(),
            selected: 0,
            first_visible: 0,
        });
        cx.notify();
        request
    }

    /// Records the request a list is waiting on, or drops the list when none could be sent.
    fn menu_pending(&mut self, request: u64, pending: Option<Pending>) {
        let Some(menu) = &mut self.features.menu else {
            return;
        };
        if menu.request != request {
            return;
        }
        match pending {
            Some(pending) => menu.pending = Some(pending),
            None => {
                self.features.menu = None;
                self.notice("No language server is running for this file");
            }
        }
    }

    /// Closes the list, giving up on a request that is out.
    pub(super) fn close_menu(&mut self) {
        let Some(menu) = self.features.menu.take() else {
            return;
        };
        if let Some(pending) = menu.pending {
            pending.cancel();
        }
    }

    /// Lists the places an answer found.
    pub(super) fn locations_arrived(&mut self, request: u64, items: Vec<LocationItem>, cx: &mut Context<Self>) {
        let Some(menu) = &mut self.features.menu else {
            return;
        };
        if menu.request != request {
            return;
        }
        menu.pending = None;
        let title = menu.title.clone();
        self.show_locations(&title, items, cx);
    }

    /// Shows places as a list, or goes straight to the only one, or says there are none.
    pub(super) fn show_locations(&mut self, title: &str, items: Vec<LocationItem>, cx: &mut Context<Self>) {
        let Some(document) = self.document else {
            return;
        };
        self.close_menu();
        if items.is_empty() {
            self.notice(&format!("No {} found", title.to_lowercase()));
            cx.notify();
            return;
        }
        if items.len() == 1 {
            let item = &items[0];
            self.open_location(item.path.clone(), item.line, item.character, cx);
            return;
        }
        let paths: Vec<&Path> = items.iter().map(|item| item.path.as_path()).collect();
        let base = common_directory(&paths);
        let rows = items
            .iter()
            .map(|item| MenuRow {
                title: format!("{}:{}", display_path(&item.path, &base), item.line + 1),
                detail: item.text.clone(),
                preview: Some(item.preview.clone()),
                disabled: None,
                action: MenuAction::Open { path: item.path.clone(), line: item.line, character: item.character },
            })
            .collect();
        let title = format!("{} {}", items.len(), title.to_lowercase());
        let request = self.next_request_number();
        self.features.menu = Some(Menu {
            kind: MenuKind::Locations,
            title,
            document,
            request,
            pending: None,
            rows,
            selected: 0,
            first_visible: 0,
        });
        cx.notify();
    }

    /// Asks which actions the server offers at the cursor or selection, and lists them.
    pub(super) fn show_code_actions(&mut self, cx: &mut Context<Self>) {
        let Some(document) = self.document else {
            return;
        };
        if self.read_only || !self.lsp.capabilities(document).is_some_and(|capabilities| capabilities.code_action) {
            self.notice("No code actions available");
            return;
        }
        let Some(range) = self.selection_range() else {
            return;
        };
        let Some(uri) = self.lsp.uri_of(document) else {
            return;
        };
        let diagnostics = self.lsp.diagnostics_at(document, &range);
        let params = actions::request_params(&uri, json!(range), &diagnostics);
        let request = self.start_menu("Code actions", MenuKind::CodeActions, document, cx);
        let sender = self.signals.clone();
        let reply = Box::new(move |result: Result<Value, ResponseError>| {
            let mut found = match result {
                Ok(answer) => actions::parse_actions(&answer),
                Err(_) => Vec::new(),
            };
            actions::order_for_menu(&mut found);
            let _ = sender.unbounded_send(Signal::Feature(FeatureSignal::Actions { request, actions: found }));
        });
        let pending = self.lsp.request_for(document, "textDocument/codeAction", params, reply);
        self.menu_pending(request, pending);
    }

    /// The newest selection as a range in the server's positions.
    fn selection_range(&self) -> Option<Range> {
        self.read(|state| {
            let selection = state.selections().newest();
            let buffer = state.buffer();
            let point = |position: Position| buffer.utf16_point_of(buffer.offset_of(position));
            let (start, end) = (point(selection.start()), point(selection.end()));
            Range {
                start: lsp_client::protocol::Position { line: start.line, character: start.character },
                end: lsp_client::protocol::Position { line: end.line, character: end.character },
            }
        })
    }

    /// Lists the actions an answer offers.
    pub(super) fn actions_arrived(&mut self, request: u64, found: Vec<CodeAction>, cx: &mut Context<Self>) {
        let Some(menu) = &mut self.features.menu else {
            return;
        };
        if menu.request != request {
            return;
        }
        menu.pending = None;
        if found.is_empty() {
            self.close_menu();
            self.notice("No code actions available");
            cx.notify();
            return;
        }
        menu.rows = found.into_iter().map(action_row).collect();
        menu.selected = 0;
        cx.notify();
    }

    /// Handles a key while a list is up. Returns whether it used the key.
    pub(super) fn menu_key(&mut self, keystroke: &Keystroke, cx: &mut Context<Self>) -> bool {
        let Some(menu) = &mut self.features.menu else {
            return false;
        };
        let key = keystroke.key.as_str();
        let modifiers = keystroke.modifiers;
        let step = match (key, modifiers.control, modifiers.shift, modifiers.alt) {
            ("down", false, false, false) | ("n", true, false, false) => 1,
            ("up", false, false, false) | ("p", true, false, false) => -1,
            ("pagedown", false, false, false) => MENU_ROWS as isize,
            ("pageup", false, false, false) => -(MENU_ROWS as isize),
            ("enter" | "tab", false, false, false) => {
                self.run_selected_row(cx);
                return true;
            }
            ("escape", ..) => {
                self.close_menu();
                cx.notify();
                return true;
            }
            _ if is_modifier_only(key) => return false,
            _ => {
                self.close_menu();
                cx.notify();
                return false;
            }
        };
        menu.move_selection(step);
        cx.notify();
        true
    }

    /// Chooses the row that is selected.
    pub(super) fn run_selected_row(&mut self, cx: &mut Context<Self>) {
        let Some(row) = self.features.menu.as_ref().and_then(Menu::selected_row).cloned() else {
            return;
        };
        if let Some(reason) = &row.disabled {
            self.notice(&format!("{}: {reason}", row.title));
            return;
        }
        self.close_menu();
        cx.notify();
        match row.action {
            MenuAction::Open { path, line, character } => self.open_location(path, line, character, cx),
            MenuAction::Run(action) => self.run_code_action(*action, cx),
        }
    }

    /// Chooses the row that was clicked.
    pub(super) fn choose_menu_row(&mut self, row: usize, cx: &mut Context<Self>) {
        if let Some(menu) = &mut self.features.menu {
            menu.select(row);
        }
        self.run_selected_row(cx);
    }

    /// Does what a code action says: its edit, then its command. An action that arrived without
    /// either is asked to resolve first, when the server can.
    fn run_code_action(&mut self, action: CodeAction, cx: &mut Context<Self>) {
        let Some(document) = self.document else {
            return;
        };
        let can_resolve = self.lsp.capabilities(document).is_some_and(|capabilities| capabilities.code_action_resolve);
        if action.edit.is_none() && action.command.is_none() && can_resolve {
            let (sender, receiver) = std::sync::mpsc::channel();
            let reply = Box::new(move |result: Result<Value, ResponseError>| {
                let _ = sender.send(result);
            });
            if self.lsp.request_for(document, "codeAction/resolve", action.raw.clone(), reply).is_some() {
                let mut resolved = action;
                if let Ok(Ok(answer)) = receiver.recv_timeout(std::time::Duration::from_millis(1500)) {
                    actions::merge_resolved(&mut resolved, &answer);
                }
                self.carry_out(document, resolved, cx);
                return;
            }
            self.carry_out(document, action, cx);
            return;
        }
        self.carry_out(document, action, cx);
    }

    /// Applies an action's edit and sends its command.
    fn carry_out(&mut self, document: DocumentId, action: CodeAction, cx: &mut Context<Self>) {
        if let Some(edit) = &action.edit {
            self.apply_edit_and_say(edit, &action.title);
        }
        if let Some(command) = &action.command {
            let params = json!({ "command": command["command"], "arguments": command["arguments"] });
            let reply = Box::new(|_: Result<Value, ResponseError>| {});
            self.lsp.request_for(document, "workspace/executeCommand", params, reply);
        }
        if action.edit.is_none() && action.command.is_none() {
            self.notice(&format!("{} did nothing", action.title));
        }
        cx.notify();
    }

    /// Applies a workspace edit and says how many files it changed.
    fn apply_edit_and_say(&mut self, edit: &WorkspaceEdit, title: &str) {
        let applied = self.lsp.apply_workspace_edit(edit);
        self.notice(&format!("{title}: {}", applied.summary()));
    }
}

/// The row for a code action.
fn action_row(action: CodeAction) -> MenuRow {
    let detail = action_detail(&action);
    let title = if action.is_preferred { format!("{} ★", action.title) } else { action.title.clone() };
    MenuRow {
        title,
        detail,
        preview: None,
        disabled: action.disabled.clone(),
        action: MenuAction::Run(Box::new(action)),
    }
}

/// What kind of action it is, in words.
fn action_detail(action: &CodeAction) -> String {
    let Some(kind) = &action.kind else {
        return String::new();
    };
    if action.is_quick_fix() {
        return "Quick fix".to_string();
    }
    if kind.starts_with("refactor") {
        return "Refactor".to_string();
    }
    if kind.starts_with("source") {
        return "Source action".to_string();
    }
    kind.clone()
}

/// The path of a place as the list shows it: relative to the directory all places share, or the
/// file's name when they are all in one directory.
pub fn display_path(path: &Path, base: &Path) -> String {
    let relative = path.strip_prefix(base).unwrap_or(path);
    relative.display().to_string()
}

/// Whether a key is only a modifier being held.
fn is_modifier_only(key: &str) -> bool {
    matches!(key, "shift" | "control" | "alt" | "platform" | "function")
}

#[cfg(test)]
mod tests {
    use super::*;
    use lsp_client::protocol::Position as LspPosition;

    fn target(uri: &str, line: usize, from: usize, to: usize) -> Target {
        Target {
            uri: uri.to_string(),
            range: Range { start: LspPosition { line, character: from }, end: LspPosition { line, character: to } },
        }
    }

    fn scratch_file(name: &str, text: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("grove-menu-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(name);
        std::fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn places_are_read_with_their_line_and_the_code_around_it() {
        let path = scratch_file("refs.ts", "one\ntwo\nthree\n  let total = 1;\nfive\nsix\nseven\neight\n");
        let documents = SharedDocuments::new(svelte_gpui::Emitter::default());
        let uri = lsp_client::uri::uri_from_path(&path);
        let items = location_items(&documents, &[target(&uri, 3, 6, 11), target("untitled:x", 0, 0, 1)]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "let total = 1;");
        assert_eq!(items[0].preview.first_line, 0);
        assert_eq!(items[0].preview.lines.len(), 7);
        assert_eq!(items[0].preview.focus, 3);
        assert_eq!(items[0].preview.columns, (6, 11));
    }

    #[test]
    fn an_open_document_is_read_as_it_is_not_as_it_was_saved() {
        let path = scratch_file("open.ts", "saved\n");
        let documents = SharedDocuments::new(svelte_gpui::Emitter::default());
        let id = documents.open(&path.display().to_string()).unwrap().id;
        documents.apply(id, &editor_core::Command::InsertText { text: "unsaved ".into() }).unwrap();
        let uri = lsp_client::uri::uri_from_path(&path);
        let items = location_items(&documents, &[target(&uri, 0, 0, 1)]);
        assert_eq!(items[0].text, "unsaved saved");
    }

    #[test]
    fn paths_are_shown_without_the_directory_they_share() {
        let a = Path::new("/work/app/src/a.ts");
        let b = Path::new("/work/app/src/deep/b.ts");
        let base = common_directory(&[a, b]);
        assert_eq!(base, PathBuf::from("/work/app/src"));
        assert_eq!(display_path(b, &base), "deep/b.ts");
        assert_eq!(common_directory(&[a]), PathBuf::from("/work/app/src"));
        assert_eq!(common_directory(&[Path::new("/x/a.ts"), Path::new("/y/b.ts")]), PathBuf::from("/"));
    }

    #[test]
    fn the_selection_wraps_round_the_ends_and_scrolls_the_list() {
        let rows = (0..25)
            .map(|index| MenuRow {
                title: index.to_string(),
                detail: String::new(),
                preview: None,
                disabled: None,
                action: MenuAction::Open { path: PathBuf::new(), line: 0, character: 0 },
            })
            .collect();
        let mut menu = Menu {
            kind: MenuKind::Locations,
            title: String::new(),
            document: 1,
            request: 1,
            pending: None,
            rows,
            selected: 0,
            first_visible: 0,
        };
        menu.move_selection(-1);
        assert_eq!((menu.selected, menu.first_visible), (24, 15));
        menu.move_selection(1);
        assert_eq!((menu.selected, menu.first_visible), (0, 0));
        menu.move_selection(MENU_ROWS as isize);
        assert_eq!(menu.selected, 10);
        assert_eq!(menu.first_visible, 1);
    }
}
