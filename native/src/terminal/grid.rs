//! The visible part of a terminal's grid as what the element paints: backgrounds in spans, text
//! in runs of one style, and the cursor. Building this is the only place that reads cells, and it
//! needs no window, so it can be tested by feeding a terminal bytes and looking at what comes out.
//!
//! Rows count from zero at the top of the viewport. A terminal scrolled back by `display_offset`
//! lines shows grid lines above zero, which this turns into viewport rows.

use alacritty_terminal::Term;
use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::Point;
use alacritty_terminal::selection::SelectionRange;
use alacritty_terminal::term::TermMode;
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::vte::ansi::{CursorShape, Rgb};

use super::glyphs;
use super::theme::{TerminalTheme, dimmed};

/// How a run is underlined.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnderlineKind {
    Single,
    Double,
    Curly,
    Dotted,
    Dashed,
}

/// Text of one style on one row, starting at a column.
#[derive(Clone, Debug, PartialEq)]
pub struct TextSpan {
    pub row: usize,
    pub column: usize,
    pub text: String,
    /// The cells it covers, which is more than the characters when one is wide.
    pub cell_count: usize,
    pub foreground: Rgb,
    pub bold: bool,
    pub italic: bool,
    pub underline: Option<UnderlineKind>,
    pub strikethrough: bool,
    /// Whether the span is one double-width character, which is painted on its own.
    pub wide: bool,
}

/// A run of cells on one row with a background that is not the terminal's own.
#[derive(Clone, Debug, PartialEq)]
pub struct BackgroundSpan {
    pub row: usize,
    pub column: usize,
    pub cell_count: usize,
    pub color: Rgb,
}

/// A box-drawing or block character the element draws itself (see `glyphs.rs`).
#[derive(Clone, Debug, PartialEq)]
pub struct DrawnGlyph {
    pub row: usize,
    pub column: usize,
    pub character: char,
    pub color: Rgb,
}

/// The cursor as it is painted: where, in which shape, and the cell under it.
#[derive(Clone, Debug, PartialEq)]
pub struct CursorCell {
    pub row: usize,
    pub column: usize,
    pub shape: CursorShape,
    /// The text of the cell, for a block cursor to draw over.
    pub text: String,
    pub wide: bool,
    pub bold: bool,
    pub italic: bool,
}

/// One frame's worth of the terminal.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub rows: usize,
    pub columns: usize,
    /// How many lines the view is scrolled back from the bottom.
    pub display_offset: usize,
    /// How many lines of history there are above the screen.
    pub history_size: usize,
    pub backgrounds: Vec<BackgroundSpan>,
    pub spans: Vec<TextSpan>,
    pub glyphs: Vec<DrawnGlyph>,
    pub cursor: Option<CursorCell>,
    /// The selected cells as row, first column and last column, inclusive.
    pub selection: Vec<(usize, usize, usize)>,
    pub mode: TermMode,
    pub background: Rgb,
}

/// The style a cell is painted in, which decides whether it can join the run before it.
#[derive(Clone, Copy, PartialEq)]
struct CellStyle {
    foreground: Rgb,
    bold: bool,
    italic: bool,
    underline: Option<UnderlineKind>,
    strikethrough: bool,
}

/// Reads the visible grid of a terminal into a snapshot.
pub fn snapshot<L: EventListener>(term: &Term<L>, theme: &TerminalTheme) -> Snapshot {
    let content = term.renderable_content();
    let rows = term.screen_lines();
    let columns = term.columns();
    let display_offset = content.display_offset;
    let default_background = theme.resolve(
        alacritty_terminal::vte::ansi::Color::Named(alacritty_terminal::vte::ansi::NamedColor::Background),
        content.colors,
    );
    let mut builder = SnapshotBuilder::new(display_offset, default_background);
    for indexed in content.display_iter {
        builder.add_cell(indexed.point, indexed.cell, theme, content.colors);
    }
    builder.finish_row();
    let cursor = cursor_cell(term, content.cursor.point, content.cursor.shape, display_offset, rows);
    let selection = match content.selection {
        Some(range) => selected_spans(&range, display_offset, rows, columns),
        None => Vec::new(),
    };
    Snapshot {
        rows,
        columns,
        display_offset,
        history_size: term.history_size(),
        backgrounds: builder.backgrounds,
        spans: builder.spans,
        glyphs: builder.glyphs,
        cursor,
        selection,
        mode: content.mode,
        background: default_background,
    }
}

/// Collects spans while cells arrive in reading order.
struct SnapshotBuilder {
    display_offset: usize,
    default_background: Rgb,
    backgrounds: Vec<BackgroundSpan>,
    spans: Vec<TextSpan>,
    glyphs: Vec<DrawnGlyph>,
    row: Option<usize>,
    open: Option<(TextSpan, CellStyle)>,
}

impl SnapshotBuilder {
    /// A builder for a view scrolled back by `display_offset` lines.
    fn new(display_offset: usize, default_background: Rgb) -> Self {
        SnapshotBuilder {
            display_offset,
            default_background,
            backgrounds: Vec::new(),
            spans: Vec::new(),
            glyphs: Vec::new(),
            row: None,
            open: None,
        }
    }

    /// Takes the next cell in reading order.
    fn add_cell(
        &mut self,
        point: Point,
        cell: &Cell,
        theme: &TerminalTheme,
        overrides: &alacritty_terminal::term::color::Colors,
    ) {
        let row = (point.line.0 + self.display_offset as i32).max(0) as usize;
        if self.row != Some(row) {
            self.finish_row();
            self.row = Some(row);
        }
        let flags = cell.flags;
        if flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
            return;
        }
        let (foreground, background) = cell_colors(cell, theme, overrides);
        let column = point.column.0;
        let wide = flags.contains(Flags::WIDE_CHAR);
        let cell_count = if wide { 2 } else { 1 };
        if background != self.default_background {
            self.add_background(row, column, cell_count, background);
        }
        let style = CellStyle {
            foreground,
            bold: flags.contains(Flags::BOLD),
            italic: flags.contains(Flags::ITALIC),
            underline: underline_of(flags),
            strikethrough: flags.contains(Flags::STRIKEOUT),
        };
        self.add_text(row, column, cell, style, wide, cell_count);
    }

    /// Extends the background span before this cell when it touches and matches, else starts one.
    fn add_background(&mut self, row: usize, column: usize, cell_count: usize, color: Rgb) {
        if let Some(last) = self.backgrounds.last_mut() {
            if last.row == row && last.color == color && last.column + last.cell_count == column {
                last.cell_count += cell_count;
                return;
            }
        }
        self.backgrounds.push(BackgroundSpan { row, column, cell_count, color });
    }

    /// Adds a cell's text to the open span, or closes that one and opens another.
    fn add_text(&mut self, row: usize, column: usize, cell: &Cell, style: CellStyle, wide: bool, cell_count: usize) {
        let decorated = style.underline.is_some() || style.strikethrough;
        let blank = (cell.c == ' ' || cell.c == '\0') && !decorated;
        if wide {
            self.close_span();
            let mut text = String::new();
            push_cell_text(&mut text, cell);
            self.spans.push(span_for(row, column, text, cell_count, style, true));
            return;
        }
        if blank {
            self.add_blank(column);
            return;
        }
        if glyphs::is_drawn(cell.c) {
            self.close_span();
            self.glyphs.push(DrawnGlyph { row, column, character: cell.c, color: style.foreground });
            return;
        }
        if let Some((span, open_style)) = &mut self.open {
            if *open_style == style && span.column + span.cell_count == column {
                push_cell_text(&mut span.text, cell);
                span.cell_count += 1;
                return;
            }
        }
        self.close_span();
        let mut text = String::new();
        push_cell_text(&mut text, cell);
        self.open = Some((span_for(row, column, text, 1, style, false), style));
    }

    /// Keeps the open span going across a blank cell, or leaves a gap when the span ended before it.
    fn add_blank(&mut self, column: usize) {
        let Some((span, _)) = &mut self.open else {
            return;
        };
        if span.column + span.cell_count != column {
            self.close_span();
            return;
        }
        span.text.push(' ');
        span.cell_count += 1;
    }

    /// Ends the open span, without the blanks that trail it.
    fn close_span(&mut self) {
        let Some((mut span, _)) = self.open.take() else {
            return;
        };
        let trimmed = span.text.trim_end_matches(' ').len();
        let trailing_blanks = span.text.len() - trimmed;
        span.text.truncate(trimmed);
        span.cell_count -= trailing_blanks;
        if span.text.is_empty() {
            return;
        }
        self.spans.push(span);
    }

    /// Ends the row being read.
    fn finish_row(&mut self) {
        self.close_span();
    }
}

/// A span of one cell's text; later cells of the same style are appended to it.
fn span_for(row: usize, column: usize, text: String, cell_count: usize, style: CellStyle, wide: bool) -> TextSpan {
    TextSpan {
        row,
        column,
        text,
        cell_count,
        foreground: style.foreground,
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        strikethrough: style.strikethrough,
        wide,
    }
}

/// Appends a cell's character and the combining characters stacked on it.
fn push_cell_text(text: &mut String, cell: &Cell) {
    let character = match cell.c {
        '\0' => ' ',
        other => other,
    };
    text.push(character);
    if let Some(combining) = cell.zerowidth() {
        text.extend(combining);
    }
}

/// How the cell's flags underline it.
fn underline_of(flags: Flags) -> Option<UnderlineKind> {
    if flags.contains(Flags::UNDERCURL) {
        return Some(UnderlineKind::Curly);
    }
    if flags.contains(Flags::DOUBLE_UNDERLINE) {
        return Some(UnderlineKind::Double);
    }
    if flags.contains(Flags::DOTTED_UNDERLINE) {
        return Some(UnderlineKind::Dotted);
    }
    if flags.contains(Flags::DASHED_UNDERLINE) {
        return Some(UnderlineKind::Dashed);
    }
    if flags.contains(Flags::UNDERLINE) {
        return Some(UnderlineKind::Single);
    }
    None
}

/// The text and background colours of a cell after inverse, dim and hidden are applied.
fn cell_colors(cell: &Cell, theme: &TerminalTheme, overrides: &alacritty_terminal::term::color::Colors) -> (Rgb, Rgb) {
    let mut foreground = theme.resolve(cell.fg, overrides);
    let mut background = theme.resolve(cell.bg, overrides);
    if cell.flags.contains(Flags::INVERSE) {
        std::mem::swap(&mut foreground, &mut background);
    }
    if cell.flags.contains(Flags::DIM) && !cell.flags.contains(Flags::INVERSE) {
        foreground = dimmed(foreground);
    }
    if cell.flags.contains(Flags::HIDDEN) {
        foreground = background;
    }
    (foreground, background)
}

/// The cursor's cell in viewport rows, or none while it is scrolled out of view or hidden.
fn cursor_cell<L: EventListener>(
    term: &Term<L>,
    point: Point,
    shape: CursorShape,
    display_offset: usize,
    rows: usize,
) -> Option<CursorCell> {
    if shape == CursorShape::Hidden {
        return None;
    }
    let row = point.line.0 + display_offset as i32;
    if row < 0 || row as usize >= rows {
        return None;
    }
    let cell = &term.grid()[point];
    let mut text = String::new();
    push_cell_text(&mut text, cell);
    Some(CursorCell {
        row: row as usize,
        column: point.column.0,
        shape,
        text,
        wide: cell.flags.contains(Flags::WIDE_CHAR),
        bold: cell.flags.contains(Flags::BOLD),
        italic: cell.flags.contains(Flags::ITALIC),
    })
}

/// The selected cells of each viewport row as inclusive column ranges.
pub fn selected_spans(
    range: &SelectionRange,
    display_offset: usize,
    rows: usize,
    columns: usize,
) -> Vec<(usize, usize, usize)> {
    let mut spans = Vec::new();
    if columns == 0 {
        return spans;
    }
    for row in 0..rows {
        let line = row as i32 - display_offset as i32;
        if line < range.start.line.0 || line > range.end.line.0 {
            continue;
        }
        let first = first_selected_column(range, line);
        let last = last_selected_column(range, line, columns);
        if first <= last {
            spans.push((row, first, last));
        }
    }
    spans
}

/// The leftmost selected column on a line of the range.
fn first_selected_column(range: &SelectionRange, line: i32) -> usize {
    if range.is_block || line == range.start.line.0 {
        return range.start.column.0;
    }
    0
}

/// The rightmost selected column on a line of the range.
fn last_selected_column(range: &SelectionRange, line: i32, columns: usize) -> usize {
    if range.is_block || line == range.end.line.0 {
        return range.end.column.0.min(columns - 1);
    }
    columns - 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::index::{Column, Line};
    use alacritty_terminal::term::Config;
    use alacritty_terminal::vte::ansi::Processor;

    use crate::terminal::session::GridSize;

    /// A terminal of the given size with the bytes already fed to it.
    fn terminal_with(columns: usize, rows: usize, input: &str) -> Term<VoidListener> {
        let mut term = Term::new(Config::default(), &GridSize::new(columns, rows), VoidListener);
        let mut processor: Processor = Processor::new();
        processor.advance(&mut term, input.as_bytes());
        term
    }

    fn spans_of(term: &Term<VoidListener>) -> Vec<TextSpan> {
        snapshot(term, &TerminalTheme::default()).spans
    }

    #[test]
    fn plain_text_is_one_span_without_its_trailing_blanks() {
        let spans = spans_of(&terminal_with(20, 3, "hello world"));
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "hello world");
        assert_eq!((spans[0].row, spans[0].column, spans[0].cell_count), (0, 0, 11));
    }

    #[test]
    fn a_colour_change_starts_a_new_span() {
        let theme = TerminalTheme::default();
        let spans = spans_of(&terminal_with(20, 3, "\x1b[31mred\x1b[0m plain"));
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].text, "red");
        assert_eq!(spans[0].foreground, theme.ansi[1]);
        assert_eq!(spans[1].text, "plain");
        assert_eq!(spans[1].column, 4);
        assert_eq!(spans[1].foreground, theme.foreground);
    }

    #[test]
    fn bold_italic_and_underline_are_kept() {
        let spans = spans_of(&terminal_with(20, 3, "\x1b[1;3;4mx\x1b[0m\x1b[9my"));
        assert!(spans[0].bold && spans[0].italic);
        assert_eq!(spans[0].underline, Some(UnderlineKind::Single));
        assert!(spans[1].strikethrough);
    }

    #[test]
    fn a_background_is_one_span_across_cells_of_the_same_colour() {
        let theme = TerminalTheme::default();
        let snapshot = snapshot(&terminal_with(20, 3, "\x1b[44m  ab\x1b[0m"), &theme);
        assert_eq!(snapshot.backgrounds.len(), 1);
        let span = &snapshot.backgrounds[0];
        assert_eq!((span.row, span.column, span.cell_count), (0, 0, 4));
        assert_eq!(span.color, theme.ansi[4]);
    }

    #[test]
    fn inverse_swaps_the_colours() {
        let theme = TerminalTheme::default();
        let snapshot = snapshot(&terminal_with(20, 3, "\x1b[7mx"), &theme);
        assert_eq!(snapshot.backgrounds[0].color, theme.foreground);
        assert_eq!(snapshot.spans[0].foreground, theme.background);
    }

    #[test]
    fn box_drawing_is_left_out_of_the_text_for_the_element_to_draw() {
        let snapshot = snapshot(&terminal_with(20, 3, "a\u{250c}\u{2500}b"), &TerminalTheme::default());
        assert_eq!(snapshot.spans.iter().map(|span| span.text.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        let drawn: Vec<(usize, char)> = snapshot.glyphs.iter().map(|glyph| (glyph.column, glyph.character)).collect();
        assert_eq!(drawn, vec![(1, '\u{250c}'), (2, '\u{2500}')]);
    }

    #[test]
    fn a_wide_character_is_its_own_span_of_two_cells() {
        let spans = spans_of(&terminal_with(20, 3, "a\u{4e2d}b"));
        assert_eq!(spans.len(), 3);
        assert!(spans[1].wide);
        assert_eq!((spans[1].column, spans[1].cell_count), (1, 2));
        assert_eq!(spans[2].column, 3);
    }

    #[test]
    fn rows_follow_the_lines_and_the_scrollback_offset() {
        let mut term = terminal_with(10, 2, "one\r\ntwo\r\nthree");
        let spans = spans_of(&term);
        assert_eq!(spans.iter().map(|span| span.text.as_str()).collect::<Vec<_>>(), ["two", "three"]);
        term.scroll_display(alacritty_terminal::grid::Scroll::Delta(1));
        let scrolled = snapshot(&term, &TerminalTheme::default());
        assert_eq!(scrolled.display_offset, 1);
        assert_eq!(scrolled.spans.iter().map(|span| span.text.as_str()).collect::<Vec<_>>(), ["one", "two"]);
        assert_eq!(scrolled.cursor, None);
    }

    #[test]
    fn the_snapshot_knows_how_much_history_there_is() {
        let term = terminal_with(10, 2, "one\r\ntwo\r\nthree\r\nfour");
        assert_eq!(snapshot(&term, &TerminalTheme::default()).history_size, 2);
    }

    #[test]
    fn the_cursor_is_where_the_text_ended() {
        let snapshot = snapshot(&terminal_with(10, 3, "ab\r\ncd"), &TerminalTheme::default());
        let cursor = snapshot.cursor.expect("a cursor");
        assert_eq!((cursor.row, cursor.column), (1, 2));
        assert_eq!(cursor.shape, CursorShape::Block);
    }

    #[test]
    fn a_selection_covers_whole_middle_lines_and_clips_the_ends() {
        let range = SelectionRange::new(Point::new(Line(0), Column(3)), Point::new(Line(2), Column(1)), false);
        assert_eq!(selected_spans(&range, 0, 4, 10), vec![(0, 3, 9), (1, 0, 9), (2, 0, 1)]);
        let block = SelectionRange::new(Point::new(Line(0), Column(2)), Point::new(Line(1), Column(4)), true);
        assert_eq!(selected_spans(&block, 0, 4, 10), vec![(0, 2, 4), (1, 2, 4)]);
        assert_eq!(selected_spans(&range, 1, 4, 10), vec![(1, 3, 9), (2, 0, 9), (3, 0, 1)]);
    }
}
