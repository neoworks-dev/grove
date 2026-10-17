//! What the person can switch in the editor, set from the app's settings through the
//! `editor_configure` command and read by every view when it paints or scrolls.

use serde_json::Value;

/// The settings the views follow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EditorOptions {
    /// Whether page jumps and wheel notches glide instead of snapping.
    pub smooth_scroll: bool,
    /// Whether a line per indentation level is drawn.
    pub indent_guides: bool,
    /// Whether the other occurrences of the word under the cursor are highlighted.
    pub occurrence_highlights: bool,
}

impl Default for EditorOptions {
    /// Everything on, as the bundled nvim had it.
    fn default() -> Self {
        EditorOptions { smooth_scroll: true, indent_guides: true, occurrence_highlights: true }
    }
}

impl EditorOptions {
    /// These options with whichever of `smoothScroll`, `indentGuides` and `occurrenceHighlights`
    /// the arguments carry applied; the rest stay as they are.
    pub fn updated_from(self, arguments: &Value) -> EditorOptions {
        let flag = |name: &str, current: bool| match arguments.get(name).and_then(Value::as_bool) {
            Some(value) => value,
            None => current,
        };
        EditorOptions {
            smooth_scroll: flag("smoothScroll", self.smooth_scroll),
            indent_guides: flag("indentGuides", self.indent_guides),
            occurrence_highlights: flag("occurrenceHighlights", self.occurrence_highlights),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn arguments_change_only_the_options_they_name() {
        let options = EditorOptions::default().updated_from(&json!({ "smoothScroll": false, "indentGuides": "yes" }));
        assert!(!options.smooth_scroll);
        assert!(options.indent_guides);
        assert!(options.occurrence_highlights);
    }
}
