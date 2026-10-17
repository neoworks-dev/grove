//! Marking the other occurrences of the word under the cursor. The marks are decorations of the
//! document (see `editor_core::occurrences`), so every view of it shows them. They go as soon as
//! the cursor moves and come back once it has rested for a moment, the way vim-illuminate does,
//! so moving through code does not flicker with highlights.

use std::time::Duration;

use editor_core::Command;
use editor_core::decorations::Decoration;
use editor_core::occurrences::{SERVER_SOURCE, SOURCE, occurrence_decorations};
use svelte_gpui::gpui::Context;

use super::Editor;
use super::element::VisibleRow;

/// How long the cursor rests before its word's occurrences are marked.
const REST_BEFORE_MARKING: Duration = Duration::from_millis(150);

impl Editor {
    /// Takes the old marks off and marks the new ones once the cursor has rested. Called whenever
    /// the cursor, the text or the scroll position may have changed.
    pub(super) fn occurrences_may_have_changed(&mut self, cx: &mut Context<Self>) {
        self.occurrence_generation += 1;
        let generation = self.occurrence_generation;
        self.set_occurrences(Vec::new(), cx);
        self.clear_server_highlights(cx);
        if !self.documents.options().occurrence_highlights {
            return;
        }
        cx.spawn(async move |editor, cx| {
            cx.background_executor().timer(REST_BEFORE_MARKING).await;
            let _ = editor.update(cx, |editor, cx| editor.mark_occurrences(generation, cx));
        })
        .detach();
    }

    /// Marks the occurrences of the word under the cursor, unless the cursor moved again meanwhile.
    fn mark_occurrences(&mut self, generation: u64, cx: &mut Context<Self>) {
        if generation != self.occurrence_generation {
            return;
        }
        if self.server_highlights_available() {
            let single_cursor = self.read(|state| state.selections().count() == 1);
            if single_cursor == Some(true) {
                self.request_highlights();
            }
            return;
        }
        let Some((first_row, last_row)) = self.visible_text_rows() else {
            return;
        };
        let margin = self.rows_in_view();
        let rows = first_row.saturating_sub(margin)..last_row + 1 + margin;
        let decorations = self.read(|state| {
            let newest = state.selections().newest();
            let single_cursor = state.selections().count() == 1 && newest.is_empty();
            if !single_cursor || state.decoration_count(SERVER_SOURCE) > 0 {
                return Vec::new();
            }
            occurrence_decorations(state.buffer(), newest.head, rows)
        });
        self.set_occurrences(decorations.unwrap_or_default(), cx);
    }

    /// Takes the server's highlights off the document, and gives up on a question about them.
    fn clear_server_highlights(&mut self, cx: &mut Context<Self>) {
        if let Some(pending) = self.features.highlight_pending.take() {
            pending.cancel();
        }
        let Some(id) = self.document else {
            return;
        };
        let marked = self.read(|state| state.decoration_count(SERVER_SOURCE)).unwrap_or(0);
        if marked > 0 {
            self.set_source_decorations(id, SERVER_SOURCE, Vec::new(), cx);
        }
    }

    /// Replaces the marks with `decorations` and draws them, doing nothing when there were none
    /// and are none.
    fn set_occurrences(&mut self, decorations: Vec<Decoration>, cx: &mut Context<Self>) {
        let Some(id) = self.document else {
            return;
        };
        let marked = self.read(|state| state.decoration_count(SOURCE)).unwrap_or(0);
        if marked == 0 && decorations.is_empty() {
            return;
        }
        let command = Command::SetDecorations { source: SOURCE.to_string(), decorations };
        self.documents.apply(id, &command);
        self.redraw_other_views(id, cx);
        cx.notify();
    }

    /// The first and last buffer rows the last frame drew, or none before the first frame.
    pub(super) fn visible_text_rows(&self) -> Option<(usize, usize)> {
        let layout = self.layout.as_ref()?;
        let mut rows = layout.rows.iter().filter_map(|visible| match visible {
            VisibleRow::Text(line) => Some(line.row),
            VisibleRow::Block { .. } => None,
        });
        let first = rows.next()?;
        Some((first, rows.last().unwrap_or(first)))
    }
}
