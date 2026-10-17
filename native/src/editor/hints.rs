//! What the language server adds to the text without being asked at the cursor: inlay hints for
//! the rows in view, which are asked for again after the text changes or the view scrolls, and
//! the highlights of the symbol under the cursor.

use std::time::Duration;

use editor_core::decorations::Decoration;
use editor_core::occurrences::SERVER_SOURCE;
use editor_core::{Command, DocumentId};
use lsp_client::highlights::{decorations_for as highlight_decorations, parse_ranges};
use lsp_client::inlay::{self, INLAY_SOURCE, Hint};
use lsp_client::protocol::{Range, ResponseError};
use serde_json::{Value, json};
use svelte_gpui::gpui::Context;

use super::features::FeatureSignal;
use super::{Editor, Signal};

/// How long after scrolling or typing the hints are asked for again.
const HINTS_DEBOUNCE: Duration = Duration::from_millis(250);

impl Editor {
    /// Called after every frame: asks for hints when the rows in view are not all covered by the
    /// last request. The request waits a moment, so scrolling and typing do not send one each.
    pub(super) fn hints_may_be_stale(&mut self, cx: &mut Context<Self>) {
        let (Some(document), Some((first, last))) = (self.document, self.visible_text_rows()) else {
            return;
        };
        let wanted = self.lsp.settings().inlay_hints;
        let supported = self.lsp.capabilities(document).is_some_and(|capabilities| capabilities.inlay_hints);
        if !wanted || !supported {
            self.clear_hints_if_any(document, cx);
            return;
        }
        if let Some((covered, from, to)) = self.features.hints_range {
            if covered == document && from <= first && last <= to {
                return;
            }
        }
        self.arm_hints_timer(cx);
    }

    /// Forgets which rows the hints cover, so they are asked for again. Called when the text
    /// changed, the settings changed or a server asked for it.
    pub(super) fn hints_are_stale(&mut self, cx: &mut Context<Self>) {
        self.features.hints_range = None;
        self.arm_hints_timer(cx);
        cx.notify();
    }

    /// Waits a moment, then asks for the hints of the rows in view.
    fn arm_hints_timer(&mut self, cx: &mut Context<Self>) {
        if self.features.hints_timer_armed {
            return;
        }
        self.features.hints_timer_armed = true;
        cx.spawn(async move |editor, cx| {
            cx.background_executor().timer(HINTS_DEBOUNCE).await;
            let _ = editor.update(cx, |editor, cx| {
                editor.features.hints_timer_armed = false;
                editor.request_hints(cx);
            });
        })
        .detach();
    }

    /// Asks the server for the hints of the rows in view and a screenful on each side.
    fn request_hints(&mut self, cx: &mut Context<Self>) {
        let (Some(document), Some((first, last))) = (self.document, self.visible_text_rows()) else {
            return;
        };
        if !self.lsp.settings().inlay_hints {
            return;
        }
        let margin = self.rows_in_view();
        let (from, to) = (first.saturating_sub(margin), last + margin);
        let Some(uri) = self.lsp.uri_of(document) else {
            return;
        };
        let params = self.read(|state| inlay::request_params(&uri, state.buffer(), from, to));
        let Some(params) = params else {
            return;
        };
        let request = self.next_request_number();
        let sender = self.signals.clone();
        let reply = Box::new(move |result: Result<Value, ResponseError>| {
            let hints = match result {
                Ok(answer) => inlay::parse_hints(&answer),
                Err(_) => return,
            };
            let _ = sender.unbounded_send(Signal::Feature(FeatureSignal::Hints { request, hints }));
        });
        let pending = self.lsp.request_for(document, "textDocument/inlayHint", params, reply);
        if let Some(old) = self.features.hints_pending.take() {
            old.cancel();
        }
        self.features.hints_request = request;
        self.features.hints_pending = pending;
        self.features.hints_range = Some((document, from, to));
        cx.notify();
    }

    /// Shows the hints an answer carries, if it is the one being waited for.
    pub(super) fn hints_arrived(&mut self, request: u64, hints: Vec<Hint>, cx: &mut Context<Self>) {
        if request != self.features.hints_request {
            return;
        }
        self.features.hints_pending = None;
        let Some(document) = self.document else {
            return;
        };
        let decorations = self.read(|state| inlay::decorations_for(state.buffer(), &hints)).unwrap_or_default();
        self.set_source_decorations(document, INLAY_SOURCE, decorations, cx);
    }

    /// Takes the hints off the document when there are some and none are wanted.
    fn clear_hints_if_any(&mut self, document: DocumentId, cx: &mut Context<Self>) {
        let shown = self.read(|state| state.decoration_count(INLAY_SOURCE)).unwrap_or(0);
        self.features.hints_range = None;
        if shown > 0 {
            self.set_source_decorations(document, INLAY_SOURCE, Vec::new(), cx);
        }
    }

    /// Replaces the decorations of one source on a document and draws every view of it.
    pub(super) fn set_source_decorations(
        &mut self,
        document: DocumentId,
        source: &str,
        decorations: Vec<Decoration>,
        cx: &mut Context<Self>,
    ) {
        let command = Command::SetDecorations { source: source.to_string(), decorations };
        self.documents.apply(document, &command);
        self.redraw_other_views(document, cx);
        cx.notify();
    }

    // ---- highlights

    /// Whether the server answers questions about the symbol under the cursor, which then replace
    /// the matching of the word as text.
    pub(super) fn server_highlights_available(&self) -> bool {
        let Some(document) = self.document else {
            return false;
        };
        self.lsp.capabilities(document).is_some_and(|capabilities| capabilities.document_highlight)
    }

    /// Asks the server which places are the symbol at the cursor.
    pub(super) fn request_highlights(&mut self) {
        let (Some(document), Some(head)) = (self.document, self.cursor()) else {
            return;
        };
        let request = self.next_request_number();
        let sender = self.signals.clone();
        let reply = Box::new(move |result: Result<Value, ResponseError>| {
            let ranges = match result {
                Ok(answer) => parse_ranges(&answer),
                Err(_) => Vec::new(),
            };
            let _ = sender.unbounded_send(Signal::Feature(FeatureSignal::Highlights { request, ranges }));
        });
        if let Some(old) = self.features.highlight_pending.take() {
            old.cancel();
        }
        self.features.highlight_request = request;
        self.features.highlight_pending =
            self.lsp.request_at(document, head, "textDocument/documentHighlight", json!({}), reply);
    }

    /// Marks the places an answer names.
    pub(super) fn highlights_arrived(&mut self, request: u64, ranges: Vec<Range>, cx: &mut Context<Self>) {
        if request != self.features.highlight_request {
            return;
        }
        self.features.highlight_pending = None;
        let Some(document) = self.document else {
            return;
        };
        let decorations = self
            .read(|state| {
                let head = state.selections().newest().head;
                highlight_decorations(state.buffer(), &ranges, head)
            })
            .unwrap_or_default();
        self.set_source_decorations(document, SERVER_SOURCE, decorations, cx);
    }
}
