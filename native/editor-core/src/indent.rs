//! How a file is indented: tabs, or some number of spaces. The style is read from the file's own
//! lines when it is opened, as vim-sleuth did, and falls back to a default when the lines do not
//! say. Tab, Enter and vim's `>` and `<` all work in the style, so a file keeps the indentation it
//! came with.

use serde::{Deserialize, Serialize};

use crate::display::TAB_WIDTH;

/// How many lines at the top of a file are read to tell how it is indented.
const SAMPLE_LINES: usize = 2000;

/// The narrowest and widest steps between indentation levels that count as a style.
const NARROWEST_STEP: usize = 2;
const WIDEST_STEP: usize = 8;

/// One level of indentation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IndentStyle {
    /// A tab character per level.
    Tabs,
    /// This many spaces per level.
    Spaces { width: usize },
}

impl Default for IndentStyle {
    /// Four spaces, which is what Tab did before the style was read from files.
    fn default() -> Self {
        IndentStyle::Spaces { width: 4 }
    }
}

impl IndentStyle {
    /// The text of one level.
    pub fn unit(&self) -> String {
        match self {
            IndentStyle::Tabs => "\t".to_string(),
            IndentStyle::Spaces { width } => " ".repeat(*width),
        }
    }

    /// How many display columns one level is wide. A tab is as wide as the editor draws it.
    pub fn columns(&self) -> usize {
        match self {
            IndentStyle::Tabs => TAB_WIDTH,
            IndentStyle::Spaces { width } => (*width).max(1),
        }
    }

    /// What the status bar calls the style: `Tabs` or `Spaces: 2`.
    pub fn label(&self) -> String {
        match self {
            IndentStyle::Tabs => "Tabs".to_string(),
            IndentStyle::Spaces { width } => format!("Spaces: {width}"),
        }
    }
}

/// Where a buffer's indentation style came from, which decides whether changing the default
/// reaches it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndentSource {
    /// The default, because the file's lines did not say.
    Default,
    /// Read from the file's own lines.
    Detected,
    /// Chosen by the person for this file.
    Chosen,
}

/// Reads a file's indentation from its first lines: tabs when more lines start with a tab than
/// with a space, otherwise the step between levels that most lines make. None when the lines
/// show no indentation to learn from.
pub fn detect_indent(text: &str) -> Option<IndentStyle> {
    let mut tab_lines = 0;
    let mut space_lines = 0;
    let mut steps = [0usize; WIDEST_STEP + 1];
    let mut previous_spaces = 0;
    for line in text.lines().take(SAMPLE_LINES) {
        if is_blank(line) {
            continue;
        }
        if line.starts_with('\t') {
            tab_lines += 1;
            previous_spaces = 0;
            continue;
        }
        let spaces = line.chars().take_while(|character| *character == ' ').count();
        if is_comment_continuation(line, spaces) {
            continue;
        }
        if spaces > 0 {
            space_lines += 1;
        }
        if spaces > previous_spaces {
            record_step(&mut steps, spaces - previous_spaces);
        }
        previous_spaces = spaces;
    }
    if tab_lines > space_lines {
        return Some(IndentStyle::Tabs);
    }
    let width = most_common_step(&steps)?;
    Some(IndentStyle::Spaces { width })
}

/// Counts one step between indentation levels, if it is one a style could have.
fn record_step(steps: &mut [usize], step: usize) {
    if (NARROWEST_STEP..=WIDEST_STEP).contains(&step) {
        steps[step] += 1;
    }
}

/// The step most lines made, the narrower one when two tie, or none when no line made one.
fn most_common_step(steps: &[usize]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for step in NARROWEST_STEP..=WIDEST_STEP {
        if steps[step] == 0 {
            continue;
        }
        if best.is_none_or(|current| steps[step] > steps[current]) {
            best = Some(step);
        }
    }
    best
}

/// Whether a line is the ` * ` of a block comment inside tab-indented code, which one space
/// of indentation does not make a style of.
fn is_comment_continuation(line: &str, spaces: usize) -> bool {
    spaces == 1 && line[1..].starts_with('*')
}

/// Whether a line is empty or only white space.
pub fn is_blank(line: &str) -> bool {
    line.chars().all(char::is_whitespace)
}

/// How many display columns of white space a line starts with, a tab going to the next tab stop.
pub fn leading_columns(line: &str) -> usize {
    let mut columns = 0;
    for character in line.chars() {
        match character {
            ' ' => columns += 1,
            '\t' => columns += TAB_WIDTH - columns % TAB_WIDTH,
            _ => break,
        }
    }
    columns
}

/// How many leading characters one step left takes off a line: a tab, or as many leading
/// spaces as one level is wide.
pub fn outdent_length(line: &str, style: IndentStyle) -> usize {
    if line.starts_with('\t') {
        return 1;
    }
    line.chars().take(style.columns()).take_while(|character| *character == ' ').count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_space_files_are_read_as_two_spaces() {
        let text = "function a() {\n  if (b) {\n    c();\n  }\n}\n";
        assert_eq!(detect_indent(text), Some(IndentStyle::Spaces { width: 2 }));
    }

    #[test]
    fn four_space_files_are_read_as_four_spaces() {
        let text = "def a():\n    if b:\n        c()\n    return 1\n";
        assert_eq!(detect_indent(text), Some(IndentStyle::Spaces { width: 4 }));
    }

    #[test]
    fn files_that_start_lines_with_tabs_use_tabs() {
        let text = "func a() {\n\tif b {\n\t\tc()\n\t}\n}\n";
        assert_eq!(detect_indent(text), Some(IndentStyle::Tabs));
    }

    #[test]
    fn a_file_with_no_indentation_says_nothing() {
        assert_eq!(detect_indent("a\nb\n\nc\n"), None);
        assert_eq!(detect_indent(""), None);
    }

    #[test]
    fn the_block_comment_stars_of_a_tab_file_are_not_spaces() {
        let text = "/*\n * about\n * this\n */\nfunc a() {\n\tb()\n}\n";
        assert_eq!(detect_indent(text), Some(IndentStyle::Tabs));
    }

    #[test]
    fn a_stray_odd_step_does_not_outvote_the_style() {
        let text = "a {\n    b {\n        c(x,\n          y);\n    }\n}\n";
        assert_eq!(detect_indent(text), Some(IndentStyle::Spaces { width: 4 }));
    }

    #[test]
    fn blank_lines_do_not_break_the_steps() {
        let text = "a {\n\n  b {\n   \n    c\n  }\n}\n";
        assert_eq!(detect_indent(text), Some(IndentStyle::Spaces { width: 2 }));
    }

    #[test]
    fn units_and_labels_describe_the_style() {
        assert_eq!(IndentStyle::Tabs.unit(), "\t");
        assert_eq!(IndentStyle::Spaces { width: 2 }.unit(), "  ");
        assert_eq!(IndentStyle::Spaces { width: 2 }.label(), "Spaces: 2");
        assert_eq!(IndentStyle::Tabs.label(), "Tabs");
        assert_eq!(IndentStyle::Tabs.columns(), TAB_WIDTH);
    }

    #[test]
    fn leading_columns_count_tabs_to_the_next_stop() {
        assert_eq!(leading_columns("\t\tx"), 2 * TAB_WIDTH);
        assert_eq!(leading_columns("  \tx"), TAB_WIDTH);
        assert_eq!(leading_columns("x"), 0);
    }

    #[test]
    fn outdenting_takes_a_tab_or_up_to_one_level_of_spaces() {
        let two = IndentStyle::Spaces { width: 2 };
        assert_eq!(outdent_length("\tx", two), 1);
        assert_eq!(outdent_length("    x", two), 2);
        assert_eq!(outdent_length(" x", two), 1);
        assert_eq!(outdent_length("x", two), 0);
    }

    #[test]
    fn styles_round_trip_through_json() {
        let spaces = serde_json::to_value(IndentStyle::Spaces { width: 2 }).unwrap();
        assert_eq!(spaces, serde_json::json!({ "kind": "spaces", "width": 2 }));
        let tabs = serde_json::json!({ "kind": "tabs" });
        assert_eq!(serde_json::from_value::<IndentStyle>(tabs).unwrap(), IndentStyle::Tabs);
    }
}
