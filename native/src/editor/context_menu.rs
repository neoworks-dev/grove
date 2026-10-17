//! What a right-click in the editor does to the editor itself: puts the cursor where the pointer
//! is, unless the pointer is in the selection the menu is about to act on. The app shows the menu.

use editor_core::{Command, Position, Selection};
use serde_json::{Value, json};
use svelte_gpui::gpui::{Context, Pixels, Point, px};
use svelte_gpui::CommandError;

use super::Editor;

impl Editor {
    /// The `contextClick` method: takes the pointer's place in window coordinates, moves the
    /// cursor there when it is outside every selection, and answers whether text is selected.
    pub(super) fn context_click_from_app(&mut self, args: Value, cx: &mut Context<Self>) -> Result<Value, CommandError> {
        let x = args.get(0).and_then(Value::as_f64);
        let y = args.get(1).and_then(Value::as_f64);
        let (Some(x), Some(y)) = (x, y) else {
            return Err(CommandError::with_code("InvalidArguments", "contextClick takes the x and y of the pointer"));
        };
        let point = Point { x: px(x as f32), y: px(y as f32) };
        self.context_click(point, cx);
        let selected = self.read(|state| !state.selections().newest().is_empty()).unwrap_or(false);
        Ok(json!({ "selected": selected }))
    }

    /// Moves the cursor to the text under a point, unless a selection covers it.
    fn context_click(&mut self, point: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(at) = self.position_at(point) else {
            return;
        };
        let covered = self.read(|state| state.selections().all().iter().any(|selection| covers(selection, at)));
        if covered == Some(true) {
            return;
        }
        self.apply(&Command::PlaceCursor { at }, cx);
        cx.notify();
    }
}

/// Whether a selection that is not just a cursor includes a position.
fn covers(selection: &Selection, at: Position) -> bool {
    !selection.is_empty() && selection.start() <= at && at <= selection.end()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    #[test]
    fn a_selection_covers_both_ends_and_what_is_between() {
        let selection = Selection::spanning(at(1, 2), at(3, 4));
        assert!(covers(&selection, at(1, 2)));
        assert!(covers(&selection, at(2, 0)));
        assert!(covers(&selection, at(3, 4)));
        assert!(!covers(&selection, at(3, 5)));
        assert!(!covers(&selection, at(0, 9)));
    }

    #[test]
    fn a_cursor_covers_nothing() {
        let cursor = Selection::spanning(at(1, 2), at(1, 2));
        assert!(!covers(&cursor, at(1, 2)));
    }
}
