//! Marking the matches of vim's last search in the rows in view, as decorations of the document
//! that `:noh` takes away (see `editor_core::vim::hlsearch`).

use editor_core::Command;
use editor_core::vim::hlsearch::SEARCH_SOURCE;
use svelte_gpui::gpui::Context;

use super::Editor;

impl Editor {
    /// Marks the matches of the last search in the rows around the view, or clears the marks when
    /// there are none to show. Called after every command and after scrolling.
    pub(super) fn refresh_search_marks(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.document else {
            return;
        };
        let Some((first_row, last_row)) = self.visible_text_rows() else {
            return;
        };
        let margin = self.rows_in_view();
        let rows = first_row.saturating_sub(margin)..last_row + 1 + margin;
        let marks = self.documents.lock().search_highlights(id, rows);
        let marked = self.read(|state| state.decoration_count(SEARCH_SOURCE)).unwrap_or(0);
        if marked == 0 && marks.is_empty() {
            return;
        }
        let command = Command::SetDecorations { source: SEARCH_SOURCE.to_string(), decorations: marks };
        self.documents.apply(id, &command);
        self.redraw_other_views(id, cx);
        cx.notify();
    }
}
