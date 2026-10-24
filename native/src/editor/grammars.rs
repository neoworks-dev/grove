//! The grammars extensions bring: `grammars_register { grammars: [{ language, symbol, wasm,
//! highlights, injections, locals, extensions, fileNames }] }` replaces them all with the ones
//! listed, each file named by an absolute path. It answers `{ rejected: [{ language, reason }] }`
//! for the entries that could not be used, and every open document that a new grammar now
//! highlights is told to draw again with `document-syntax { id }`.

use std::path::Path;

use editor_core::syntax::{GrammarSpec, RejectedGrammar, set_grammars};
use serde_json::{Value, json};
use svelte_gpui::CommandError;

use super::documents::SharedDocuments;

/// Hands the grammars over to the editor and re-detects the language of the open documents.
pub fn register(documents: &SharedDocuments, args: &Value) -> Result<Value, CommandError> {
    let Some(entries) = args.get("grammars").and_then(Value::as_array) else {
        return Err(CommandError::with_code("InvalidArguments", "grammars_register takes a list of grammars"));
    };
    let (specs, mut rejected) = read_specs(entries);
    rejected.extend(set_grammars(specs));
    documents.refresh_syntax();
    let rejected: Vec<Value> =
        rejected.iter().map(|grammar| json!({ "language": grammar.language, "reason": grammar.reason })).collect();
    Ok(json!({ "rejected": rejected }))
}

/// Reads the files each entry names. An entry with a file that cannot be read is rejected.
fn read_specs(entries: &[Value]) -> (Vec<GrammarSpec>, Vec<RejectedGrammar>) {
    let mut specs = Vec::new();
    let mut rejected = Vec::new();
    for entry in entries {
        match read_spec(entry) {
            Ok(spec) => specs.push(spec),
            Err(reason) => {
                let language = text(entry, "language").unwrap_or_else(|| "(unnamed)".to_string());
                rejected.push(RejectedGrammar { language, reason });
            }
        }
    }
    (specs, rejected)
}

/// One entry as a spec, with its files read.
fn read_spec(entry: &Value) -> Result<GrammarSpec, String> {
    let language = text(entry, "language").ok_or("a grammar needs a language")?;
    let wasm_path = text(entry, "wasm").ok_or("a grammar needs a wasm file")?;
    let symbol = text(entry, "symbol").unwrap_or_else(|| language.clone());
    let wasm = std::fs::read(&wasm_path).map_err(|error| format!("could not read {wasm_path}: {error}"))?;
    Ok(GrammarSpec {
        highlights: read_query(entry, "highlights")?.unwrap_or_default(),
        injections: read_query(entry, "injections")?,
        locals: read_query(entry, "locals")?,
        extensions: list(entry, "extensions"),
        file_names: list(entry, "fileNames"),
        language,
        symbol,
        wasm,
    })
}

/// The source of a query file an entry names, or none when it names no such file.
fn read_query(entry: &Value, key: &str) -> Result<Option<String>, String> {
    let Some(path) = text(entry, key) else {
        return Ok(None);
    };
    std::fs::read_to_string(Path::new(&path)).map(Some).map_err(|error| format!("could not read {path}: {error}"))
}

/// A string field of an entry.
fn text(entry: &Value, key: &str) -> Option<String> {
    entry.get(key).and_then(Value::as_str).map(str::to_string)
}

/// A list of strings in an entry.
fn list(entry: &Value, key: &str) -> Vec<String> {
    let items = entry.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    items.iter().filter_map(Value::as_str).map(str::to_string).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, MutexGuard};

    use svelte_gpui::Emitter;

    use super::*;

    /// The grammars in use are the process's, so tests that change them take turns.
    static TURN: Mutex<()> = Mutex::new(());

    /// Waits for this test's turn.
    fn take_turn() -> MutexGuard<'static, ()> {
        TURN.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The directory of the sample extension that brings Zig.
    fn sample() -> String {
        format!("{}/samples/extensions/grove-zig", env!("CARGO_MANIFEST_DIR"))
    }

    /// The entry the extensions service sends for the sample's grammar.
    fn zig_entry() -> Value {
        let sample = sample();
        json!({
            "language": "zig",
            "wasm": format!("{sample}/grammars/zig.wasm"),
            "highlights": format!("{sample}/queries/highlights.scm"),
            "locals": format!("{sample}/queries/locals.scm"),
            "extensions": ["zig"],
            "fileNames": [],
        })
    }

    #[test]
    fn a_document_open_before_the_grammar_arrives_is_highlighted_after() {
        let _turn = take_turn();
        let directory = std::env::temp_dir().join(format!("grove-native-grammars-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("late.zig");
        std::fs::write(&path, "const x = 1;\n").unwrap();

        let documents = SharedDocuments::new(Emitter::default());
        let id = documents.open(&path.display().to_string()).unwrap().id;
        assert_eq!(documents.lock().get(id).unwrap().state.language_name(), None);

        let answer = register(&documents, &json!({ "grammars": [zig_entry()] })).unwrap();
        assert_eq!(answer, json!({ "rejected": [] }));
        assert_eq!(documents.lock().get(id).unwrap().state.language_name(), Some("zig"));
        assert!(!documents.lock().get(id).unwrap().state.highlights(0..1)[0].is_empty());
        register(&documents, &json!({ "grammars": [] })).unwrap();
    }

    #[test]
    fn an_entry_with_a_missing_file_is_rejected_and_the_rest_are_kept() {
        let _turn = take_turn();
        let documents = SharedDocuments::new(Emitter::default());
        let mut missing = zig_entry();
        missing["language"] = json!("ghost");
        missing["wasm"] = json!("/no/such/ghost.wasm");
        let answer = register(&documents, &json!({ "grammars": [missing, zig_entry()] })).unwrap();
        let rejected = answer["rejected"].as_array().unwrap();
        assert_eq!(rejected.len(), 1);
        assert_eq!(rejected[0]["language"], "ghost");
        assert!(rejected[0]["reason"].as_str().unwrap().contains("/no/such/ghost.wasm"));
        register(&documents, &json!({ "grammars": [] })).unwrap();
    }
}
