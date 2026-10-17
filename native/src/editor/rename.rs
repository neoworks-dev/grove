//! Renaming a symbol: a small input appears where the symbol is, with its name selected, and
//! Enter sends the new name to the server and applies the edits it answers with in every file.
//! The input is drawn by the view and takes its keys here, so it behaves like a text field
//! without being one.

use editor_core::{DocumentId, Position};
use lsp_client::edits::{RenameTarget, parse_prepare_rename, parse_workspace_edit};
use lsp_client::protocol::ResponseError;
use serde_json::{Value, json};
use svelte_gpui::gpui::{Context, Keystroke};

use super::features::FeatureSignal;
use super::hover::word_range_at;
use super::{Editor, Signal};
use crate::lsp::{Applied, Pending};

/// The input for the new name.
pub struct RenameBox {
    pub document: DocumentId,
    /// The symbol being renamed.
    pub start: Position,
    pub end: Position,
    /// The name typed so far, and where the caret is in it, counted in characters.
    pub text: String,
    pub caret: usize,
    /// Whether the whole name is selected, so typing replaces it.
    pub all_selected: bool,
    /// The number of the request whose answer is wanted, and the request itself.
    pub request: u64,
    pub pending: Option<Pending>,
    /// Whether the server has said the symbol can be renamed; the input only shows after that.
    pub ready: bool,
    /// Whether the new name has been sent and its edits are awaited.
    pub submitted: bool,
}

impl RenameBox {
    /// The text typed before the caret and after it.
    pub fn split_at_caret(&self) -> (String, String) {
        let before: String = self.text.chars().take(self.caret).collect();
        let after: String = self.text.chars().skip(self.caret).collect();
        (before, after)
    }

    /// Types text at the caret, over the selection if the whole name is selected.
    pub fn insert(&mut self, typed: &str) {
        if self.all_selected {
            self.text.clear();
            self.caret = 0;
            self.all_selected = false;
        }
        let (before, after) = self.split_at_caret();
        self.text = format!("{before}{typed}{after}");
        self.caret += typed.chars().count();
    }

    /// Deletes the character before the caret, or the selected name.
    pub fn backspace(&mut self) {
        if self.all_selected {
            self.text.clear();
            self.caret = 0;
            self.all_selected = false;
            return;
        }
        if self.caret == 0 {
            return;
        }
        let (before, after) = self.split_at_caret();
        let kept: String = before.chars().take(self.caret - 1).collect();
        self.text = format!("{kept}{after}");
        self.caret -= 1;
    }

    /// Deletes the character after the caret, or the selected name.
    pub fn delete_forward(&mut self) {
        if self.all_selected {
            self.backspace();
            return;
        }
        let (before, after) = self.split_at_caret();
        let kept: String = after.chars().skip(1).collect();
        self.text = format!("{before}{kept}");
    }

    /// Moves the caret by some characters, or to an end of the name.
    pub fn move_caret(&mut self, target: CaretMove) {
        let length = self.text.chars().count();
        self.all_selected = false;
        self.caret = match target {
            CaretMove::Left => self.caret.saturating_sub(1),
            CaretMove::Right => (self.caret + 1).min(length),
            CaretMove::Start => 0,
            CaretMove::End => length,
        };
    }
}

/// Where a key moves the caret.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaretMove {
    Left,
    Right,
    Start,
    End,
}

impl Editor {
    /// Starts renaming the symbol at the cursor: the server is asked whether it can be, and the
    /// input opens when it says so.
    pub(super) fn start_rename(&mut self, cx: &mut Context<Self>) {
        let (Some(document), Some(head)) = (self.document, self.cursor()) else {
            return;
        };
        let can_rename = self.lsp.capabilities(document).filter(|capabilities| capabilities.rename);
        let Some(capabilities) = can_rename else {
            self.notice("This language server cannot rename");
            return;
        };
        if self.read_only {
            return;
        }
        self.close_menu();
        self.close_signature();
        let request = self.next_request_number();
        let word = self.read(|state| word_range_at(&state.buffer().line(head.row), head.row, head.column)).flatten();
        let Some((start, end)) = word else {
            self.notice("Put the cursor on a name to rename it");
            return;
        };
        let mut rename = RenameBox {
            document,
            start,
            end,
            text: String::new(),
            caret: 0,
            all_selected: true,
            request,
            pending: None,
            ready: false,
            submitted: false,
        };
        if !capabilities.prepare_rename {
            self.open_rename_box(rename, None);
            cx.notify();
            return;
        }
        let sender = self.signals.clone();
        let reply = Box::new(move |result: Result<Value, ResponseError>| {
            let result = result.map(|answer| parse_prepare_rename(&answer)).map_err(|error| error.message);
            let _ = sender.unbounded_send(Signal::Feature(FeatureSignal::PrepareRename { request, result }));
        });
        rename.pending = self.lsp.request_at(document, head, "textDocument/prepareRename", json!({}), reply);
        if rename.pending.is_none() {
            self.notice("The language server is not ready");
            return;
        }
        self.features.rename = Some(rename);
    }

    /// The server's answer about whether the symbol can be renamed.
    pub(super) fn prepare_rename_arrived(
        &mut self,
        request: u64,
        result: Result<Option<RenameTarget>, String>,
        cx: &mut Context<Self>,
    ) {
        let Some(rename) = self.features.rename.take() else {
            return;
        };
        if rename.request != request || rename.ready {
            self.features.rename = Some(rename);
            return;
        }
        match result {
            Ok(Some(target)) => self.open_rename_box(rename, Some(target)),
            Ok(None) => self.notice("This cannot be renamed"),
            Err(message) => self.notice(&format!("Rename failed: {message}")),
        }
        cx.notify();
    }

    /// Shows the input, with the symbol's name in it and selected.
    fn open_rename_box(&mut self, mut rename: RenameBox, target: Option<RenameTarget>) {
        if let Some(range) = target.as_ref().and_then(|target| target.range) {
            let converted = self.read(|state| {
                let buffer = state.buffer();
                let position = |at: lsp_client::protocol::Position| {
                    let point = editor_core::Utf16Point { line: at.line, character: at.character };
                    buffer.position_of(buffer.offset_of_utf16_point(point))
                };
                (position(range.start), position(range.end))
            });
            if let Some((start, end)) = converted {
                rename.start = start;
                rename.end = end;
            }
        }
        let current = self.read(|state| state.buffer().text_between(rename.start, rename.end)).unwrap_or_default();
        let placeholder = target.and_then(|target| target.placeholder);
        rename.text = placeholder.unwrap_or(current);
        rename.caret = rename.text.chars().count();
        rename.all_selected = true;
        rename.ready = true;
        rename.pending = None;
        self.features.rename = Some(rename);
    }

    /// Handles a key while the input is open. Every key is used, so none reaches the text.
    pub(super) fn rename_key(&mut self, keystroke: &Keystroke, cx: &mut Context<Self>) -> bool {
        let Some(rename) = &mut self.features.rename else {
            return false;
        };
        if !rename.ready {
            if keystroke.key == "escape" {
                self.cancel_rename(cx);
            }
            return true;
        }
        if rename.submitted {
            return true;
        }
        let modifiers = keystroke.modifiers;
        let key = keystroke.key.as_str();
        match key {
            "escape" => self.cancel_rename(cx),
            "enter" => self.submit_rename(cx),
            "backspace" => rename.backspace(),
            "delete" => rename.delete_forward(),
            "left" => rename.move_caret(CaretMove::Left),
            "right" => rename.move_caret(CaretMove::Right),
            "home" => rename.move_caret(CaretMove::Start),
            "end" => rename.move_caret(CaretMove::End),
            "a" if modifiers.control => rename.all_selected = true,
            "v" if modifiers.control => {
                let pasted = self.clipboard_text(cx).unwrap_or_default();
                let line = pasted.lines().next().unwrap_or_default().to_string();
                if let Some(rename) = &mut self.features.rename {
                    rename.insert(&line);
                }
            }
            _ => {
                if !modifiers.control && !modifiers.alt && !modifiers.platform {
                    if let Some(typed) = keystroke.key_char.as_deref().filter(|typed| !typed.chars().any(char::is_control)) {
                        rename.insert(typed);
                    }
                }
            }
        }
        cx.notify();
        true
    }

    /// Closes the input without renaming.
    pub(super) fn cancel_rename(&mut self, cx: &mut Context<Self>) {
        if let Some(rename) = self.features.rename.take() {
            if let Some(pending) = rename.pending {
                pending.cancel();
            }
        }
        cx.notify();
    }

    /// Sends the new name, and applies the edits the server answers with.
    fn submit_rename(&mut self, cx: &mut Context<Self>) {
        let Some(rename) = &self.features.rename else {
            return;
        };
        let (start, end, document) = (rename.start, rename.end, rename.document);
        let current = self.read(|state| state.buffer().text_between(start, end)).unwrap_or_default();
        let new_name = rename.text.trim().to_string();
        if new_name.is_empty() || new_name == current {
            self.cancel_rename(cx);
            return;
        }
        let request = rename.request + 1;
        if let Some(rename) = &mut self.features.rename {
            rename.submitted = true;
            rename.request = request;
        }
        let sender = self.signals.clone();
        let store = self.lsp.clone();
        let reply = Box::new(move |result: Result<Value, ResponseError>| {
            let result = result.map_err(|error| error.message).map(|answer| {
                let edit = parse_workspace_edit(&answer);
                store.apply_workspace_edit(&edit)
            });
            if let Ok(applied) = &result {
                store.notice(&format!("Renamed: {}", applied.summary()));
            }
            let _ = sender.unbounded_send(Signal::Feature(FeatureSignal::Renamed { request, result }));
        });
        let extra = json!({ "newName": new_name });
        let pending = self.lsp.request_at(document, start, "textDocument/rename", extra, reply);
        if pending.is_none() {
            self.cancel_rename(cx);
            return;
        }
        if let Some(rename) = &mut self.features.rename {
            rename.pending = pending;
        }
    }

    /// How a rename went: the input closes, and a failure is said in the status bar.
    pub(super) fn rename_finished(&mut self, request: u64, result: Result<Applied, String>, cx: &mut Context<Self>) {
        let Some(rename) = &self.features.rename else {
            return;
        };
        if rename.request != request {
            return;
        }
        self.features.rename = None;
        if let Err(message) = result {
            self.notice(&format!("Rename failed: {message}"));
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(text: &str) -> RenameBox {
        RenameBox {
            document: 1,
            start: Position { row: 0, column: 0 },
            end: Position { row: 0, column: text.chars().count() },
            text: text.to_string(),
            caret: text.chars().count(),
            all_selected: true,
            request: 1,
            pending: None,
            ready: true,
            submitted: false,
        }
    }

    #[test]
    fn typing_replaces_the_selected_name_and_then_adds_at_the_caret() {
        let mut rename = input("total");
        rename.insert("s");
        rename.insert("um");
        assert_eq!((rename.text.as_str(), rename.caret), ("sum", 3));
        rename.move_caret(CaretMove::Left);
        rename.insert("X");
        assert_eq!(rename.text, "suXm");
    }

    #[test]
    fn deleting_works_on_characters_and_on_the_selection() {
        let mut rename = input("größe");
        rename.all_selected = false;
        rename.backspace();
        assert_eq!(rename.text, "größ");
        rename.move_caret(CaretMove::Start);
        rename.delete_forward();
        assert_eq!(rename.text, "röß");
        rename.all_selected = true;
        rename.delete_forward();
        assert_eq!(rename.text, "");
    }
}
