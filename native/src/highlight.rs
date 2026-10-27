//! Syntax colours for code outside the editor, such as the lines of an edit in the agent's chat.
//!
//! One command, `syntax_highlight { text, path }`, parses `text` in the language `path`'s name says
//! and answers with `{ "language": string | null, "lines": [[[startColumn, endColumn, name], ...]] }`:
//! per line of the text, the runs that have a highlight, as character columns and one of
//! `editor_core::syntax::HIGHLIGHT_NAMES`. A text in a language nobody knows answers `null` and
//! empty lines. The app maps each name to a colour with the theme's `syntax` table, the one the
//! editor uses.

use std::path::Path;

use editor_core::Buffer;
use editor_core::syntax::Syntax;
use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands};

/// Registers the `syntax_highlight` command.
pub fn register(commands: Commands) -> Commands {
    commands.command("syntax_highlight", |args| {
        let text = string_argument(&args, "text")?;
        let path = string_argument(&args, "path")?;
        Ok::<_, CommandError>(highlight(&text, &path))
    })
}

/// A string argument of the command, or why it is missing.
fn string_argument(args: &Value, name: &str) -> Result<String, CommandError> {
    match args.get(name).and_then(Value::as_str) {
        Some(value) => Ok(value.to_string()),
        None => Err(CommandError::with_code("InvalidArguments", format!("syntax_highlight needs a string {name}"))),
    }
}

/// The highlight runs of every line of `text`, in the language of a file called `path`.
fn highlight(text: &str, path: &str) -> Value {
    let mut buffer = Buffer::from_text_named(text, Path::new(path));
    let syntax = Syntax::new(&mut buffer);
    let rows = buffer.rope().len_lines();
    let lines: Vec<Value> = syntax
        .highlights(&buffer, 0..rows)
        .iter()
        .map(|spans| {
            let runs: Vec<Value> = spans.iter().map(|span| json!([span.start_column, span.end_column, span.id.name()])).collect();
            json!(runs)
        })
        .collect();
    json!({ "language": syntax.language_name(), "lines": lines })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_code_gets_runs_and_an_unknown_language_gets_none() {
        let answer = highlight("fn main() {}\n", "x.rs");
        assert_eq!(answer["language"], json!("rust"));
        let first_line = answer["lines"][0].as_array().unwrap();
        assert!(first_line.iter().any(|run| run[0] == json!(0) && run[1] == json!(2) && run[2] == json!("keyword")), "{first_line:?}");

        let unknown = highlight("whatever\n", "x.nonsense");
        assert_eq!(unknown["language"], Value::Null);
    }
}
