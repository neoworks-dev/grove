//! What copying takes from several selections and how pasting spreads text over them, as in
//! VS Code. The system clipboard itself belongs to the view; this only turns selections into
//! text and text back into one piece per selection.

use crate::buffer::Buffer;
use crate::selections::Selections;

/// What a copy took.
pub struct Copied {
    pub text: String,
    /// Whether the text is whole lines, taken because every selection was only a cursor.
    /// Pasting such text puts the lines above the cursor's line instead of at the cursor.
    pub whole_lines: bool,
}

/// The text a copy takes. Selected texts are joined with line breaks. When every selection is
/// only a cursor, the lines they are on are taken instead, each once, with a line break after.
pub fn copy_text(buffer: &Buffer, selections: &Selections) -> Copied {
    let nothing_selected = selections.all().iter().all(|selection| selection.is_empty());
    if nothing_selected {
        let rows = rows_of_cursors(selections);
        let lines: Vec<String> = rows.iter().map(|row| buffer.line(*row)).collect();
        return Copied { text: format!("{}\n", lines.join("\n")), whole_lines: true };
    }
    let pieces: Vec<String> = selections
        .all()
        .iter()
        .filter(|selection| !selection.is_empty())
        .map(|selection| buffer.text_between(selection.start(), selection.end()))
        .collect();
    Copied { text: pieces.join("\n"), whole_lines: false }
}

/// The distinct rows the selections' heads are on, in order.
pub fn rows_of_cursors(selections: &Selections) -> Vec<usize> {
    let mut rows: Vec<usize> = selections.all().iter().map(|selection| selection.head.row).collect();
    rows.dedup();
    rows
}

/// What each of `count` selections receives when `text` is pasted: one line each when the text
/// has exactly that many lines, otherwise all of the text at every one. Whole lines keep their
/// line break.
pub fn split_for_paste(text: &str, count: usize, whole_lines: bool) -> Vec<String> {
    let text = text.replace("\r\n", "\n");
    let body = if whole_lines { text.strip_suffix('\n').unwrap_or(&text) } else { text.as_str() };
    let lines: Vec<&str> = body.split('\n').collect();
    if count > 1 && lines.len() == count {
        let ending = if whole_lines { "\n" } else { "" };
        return lines.iter().map(|line| format!("{line}{ending}")).collect();
    }
    vec![text; count]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffer::Position;
    use crate::selections::Selection;

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    #[test]
    fn selected_texts_are_joined_with_line_breaks() {
        let buffer = Buffer::from_text("one two\nthree four");
        let mut selections = Selections::single(at(0, 0));
        selections.replace_newest(Selection::spanning(at(0, 0), at(0, 3)));
        selections.add(Selection::spanning(at(1, 6), at(1, 10)));
        let copied = copy_text(&buffer, &selections);
        assert_eq!(copied.text, "one\nfour");
        assert!(!copied.whole_lines);
    }

    #[test]
    fn empty_selections_copy_their_lines_once_each() {
        let buffer = Buffer::from_text("a\nb\nc");
        let mut selections = Selections::single(at(0, 1));
        selections.add(Selection::cursor(at(2, 0)));
        let copied = copy_text(&buffer, &selections);
        assert_eq!(copied.text, "a\nc\n");
        assert!(copied.whole_lines);
    }

    #[test]
    fn as_many_lines_as_cursors_go_one_each() {
        assert_eq!(split_for_paste("a\nb\nc", 3, false), vec!["a", "b", "c"]);
        assert_eq!(split_for_paste("a\nb\r\nc", 3, false), vec!["a", "b", "c"]);
    }

    #[test]
    fn other_counts_paste_everything_everywhere() {
        assert_eq!(split_for_paste("a\nb", 3, false), vec!["a\nb", "a\nb", "a\nb"]);
        assert_eq!(split_for_paste("a\nb", 1, false), vec!["a\nb"]);
    }

    #[test]
    fn whole_lines_keep_their_line_breaks() {
        assert_eq!(split_for_paste("a\nb\n", 2, true), vec!["a\n", "b\n"]);
        assert_eq!(split_for_paste("a\nb\n", 3, true), vec!["a\nb\n", "a\nb\n", "a\nb\n"]);
    }
}
