//! Where the pointer is on the grid, and selecting text with it. These work on the emulator and
//! on plain numbers, so the view only has to pass them what the pointer did.

use alacritty_terminal::Term;
use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use svelte_gpui::gpui::Pixels;

/// Where the last frame put the grid, which maps the pointer to cells.
#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    /// The top left of the first cell.
    pub origin: svelte_gpui::gpui::Point<Pixels>,
    pub cell_width: Pixels,
    pub line_height: Pixels,
    pub columns: usize,
    pub rows: usize,
}

/// A cell of the grid under the pointer, and which half of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hit {
    pub row: usize,
    pub column: usize,
    pub side: Side,
}

/// The cell under a point, clamped to the grid, and which half of it the point is in.
pub fn hit_in(geometry: &Geometry, position: svelte_gpui::gpui::Point<Pixels>) -> Hit {
    let across = ((position.x - geometry.origin.x) / geometry.cell_width).max(0.0);
    let down = ((position.y - geometry.origin.y) / geometry.line_height).max(0.0);
    let column = (across.floor() as usize).min(geometry.columns - 1);
    let row = (down.floor() as usize).min(geometry.rows - 1);
    let side = if across.fract() < 0.5 || across as usize >= geometry.columns { Side::Left } else { Side::Right };
    Hit { row, column, side }
}

/// The grid point of a viewport cell, given how far back the view is scrolled.
fn grid_point(display_offset: usize, hit: Hit) -> Point {
    Point::new(Line(hit.row as i32 - display_offset as i32), Column(hit.column))
}

/// Starts a selection at a cell: of cells, words or lines by `kind`. With `extend` an existing
/// selection grows to the cell instead.
pub fn start_selection<L: EventListener>(term: &mut Term<L>, hit: Hit, kind: SelectionType, extend: bool) {
    let point = grid_point(term.grid().display_offset(), hit);
    if extend && let Some(selection) = term.selection.as_mut() {
        selection.update(point, hit.side);
        return;
    }
    term.selection = Some(Selection::new(kind, point, hit.side));
}

/// Moves the end of the selection to a cell. Does nothing while there is no selection.
pub fn extend_selection<L: EventListener>(term: &mut Term<L>, hit: Hit) {
    let point = grid_point(term.grid().display_offset(), hit);
    if let Some(selection) = term.selection.as_mut() {
        selection.update(point, hit.side);
    }
}

/// Selects everything the terminal holds, history included.
pub fn select_everything<L: EventListener>(term: &mut Term<L>) {
    let top = Point::new(term.topmost_line(), Column(0));
    let bottom = Point::new(term.bottommost_line(), term.last_column());
    let mut selection = Selection::new(SelectionType::Simple, top, Side::Left);
    selection.update(bottom, Side::Right);
    term.selection = Some(selection);
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::grid::Scroll;
    use alacritty_terminal::term::Config;
    use alacritty_terminal::vte::ansi::Processor;
    use svelte_gpui::gpui::{point, px};

    use crate::terminal::session::GridSize;

    fn geometry() -> Geometry {
        Geometry {
            origin: point(px(10.0), px(20.0)),
            cell_width: px(8.0),
            line_height: px(16.0),
            columns: 80,
            rows: 24,
        }
    }

    /// A terminal of the given size with the bytes already fed to it.
    fn terminal_with(columns: usize, rows: usize, input: &str) -> Term<VoidListener> {
        let mut term = Term::new(Config::default(), &GridSize::new(columns, rows), VoidListener);
        let mut processor: Processor = Processor::new();
        processor.advance(&mut term, input.as_bytes());
        term
    }

    fn hit(row: usize, column: usize, side: Side) -> Hit {
        Hit { row, column, side }
    }

    #[test]
    fn a_point_maps_to_its_cell_and_half() {
        let left = hit_in(&geometry(), point(px(10.0 + 8.0 * 5.0 + 1.0), px(20.0 + 16.0 * 2.0 + 3.0)));
        assert_eq!(left, hit(2, 5, Side::Left));
        let right = hit_in(&geometry(), point(px(10.0 + 8.0 * 5.0 + 6.0), px(20.0)));
        assert_eq!(right, hit(0, 5, Side::Right));
    }

    #[test]
    fn a_point_outside_the_grid_is_clamped_to_its_edge() {
        let before = hit_in(&geometry(), point(px(0.0), px(0.0)));
        assert_eq!((before.row, before.column), (0, 0));
        let after = hit_in(&geometry(), point(px(5000.0), px(5000.0)));
        assert_eq!((after.row, after.column), (23, 79));
    }

    #[test]
    fn a_hit_in_the_scrollback_is_a_negative_line() {
        let cell = hit(3, 7, Side::Left);
        assert_eq!(grid_point(5, cell), Point::new(Line(-2), Column(7)));
        assert_eq!(grid_point(0, cell), Point::new(Line(3), Column(7)));
    }

    #[test]
    fn dragging_from_one_cell_to_another_selects_the_text_between() {
        let mut term = terminal_with(20, 3, "hello world\r\nsecond line");
        start_selection(&mut term, hit(0, 6, Side::Left), SelectionType::Simple, false);
        extend_selection(&mut term, hit(0, 10, Side::Right));
        assert_eq!(term.selection_to_string().as_deref(), Some("world"));
        extend_selection(&mut term, hit(1, 5, Side::Right));
        assert_eq!(term.selection_to_string().as_deref(), Some("world\nsecond"));
    }

    #[test]
    fn a_double_click_selects_the_word_under_the_pointer() {
        let mut term = terminal_with(20, 3, "hello world");
        start_selection(&mut term, hit(0, 8, Side::Left), SelectionType::Semantic, false);
        assert_eq!(term.selection_to_string().as_deref(), Some("world"));
    }

    #[test]
    fn a_triple_click_selects_the_line() {
        let mut term = terminal_with(20, 3, "hello world\r\nsecond line");
        start_selection(&mut term, hit(1, 2, Side::Left), SelectionType::Lines, false);
        assert_eq!(term.selection_to_string().as_deref(), Some("second line\n"));
    }

    #[test]
    fn shift_extends_the_selection_that_is_there() {
        let mut term = terminal_with(20, 3, "hello world");
        start_selection(&mut term, hit(0, 0, Side::Left), SelectionType::Simple, false);
        extend_selection(&mut term, hit(0, 4, Side::Right));
        start_selection(&mut term, hit(0, 10, Side::Right), SelectionType::Simple, true);
        assert_eq!(term.selection_to_string().as_deref(), Some("hello world"));
    }

    #[test]
    fn a_selection_made_while_scrolled_back_picks_the_lines_on_screen() {
        let mut term = terminal_with(10, 2, "one\r\ntwo\r\nthree");
        term.scroll_display(Scroll::Delta(1));
        start_selection(&mut term, hit(0, 0, Side::Left), SelectionType::Lines, false);
        assert_eq!(term.selection_to_string().as_deref(), Some("one\n"));
    }

    #[test]
    fn selecting_everything_takes_the_history_too() {
        let mut term = terminal_with(10, 2, "one\r\ntwo\r\nthree");
        select_everything(&mut term);
        let text = term.selection_to_string().expect("a selection");
        assert!(text.starts_with("one\ntwo\nthree"));
    }
}
