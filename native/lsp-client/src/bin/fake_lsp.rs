//! A small language server for the tests: it keeps the text of the documents it is told about,
//! reports every `BAD` in them as an error, completes a fixed list of words, answers hover and
//! definition, adds documentation to an item when it is resolved (and, like `vtsls`, the
//! parentheses of a function call when the client's settings ask for them), and ends when a document contains `CRASH`. It also answers the requests around the
//! cursor with simple rules: signature help for a call to `alpha`, a hint after the first word
//! of every line, references and highlights of the word at a place, a rename of it, a fix
//! for each `BAD`, and a formatter that strips trailing white space. It applies changes with its own
//! reading of UTF-16 columns, so a test that compares its view of the text with the editor's
//! checks the editor's changes against an independent implementation.

use std::collections::HashMap;
use std::io::{BufReader, stdin, stdout};

use lsp_client::rpc::{read_message, write_message};
use serde_json::{Value, json};

/// Serves the conversation on stdin and stdout until the client says exit or the stream ends.
fn main() {
    let mut reader = BufReader::new(stdin().lock());
    let mut writer = stdout().lock();
    let mut documents: HashMap<String, String> = HashMap::new();
    let mut complete_function_calls = false;
    while let Ok(Some(message)) = read_message(&mut reader) {
        if message.get("method").is_none() && message["id"] == 9001 {
            continue;
        }
        if message.get("method").is_none() && message["id"] == 9000 {
            complete_function_calls = message["result"][2]["suggest"]["completeFunctionCalls"] == true;
            report_configuration(&mut writer, &message);
            continue;
        }
        let method = message["method"].as_str().unwrap_or_default().to_string();
        let params = message["params"].clone();
        let id = message.get("id").cloned();
        match method.as_str() {
            "textDocument/didOpen" => {
                let document = &params["textDocument"];
                let uri = document["uri"].as_str().unwrap_or_default().to_string();
                documents.insert(uri.clone(), document["text"].as_str().unwrap_or_default().to_string());
                publish(&mut writer, &uri, document["version"].clone(), &documents[&uri]);
            }
            "textDocument/didChange" => {
                let uri = params["textDocument"]["uri"].as_str().unwrap_or_default().to_string();
                let text = documents.entry(uri.clone()).or_default();
                for change in params["contentChanges"].as_array().cloned().unwrap_or_default() {
                    apply_change(text, &change);
                }
                if text.contains("CRASH") {
                    eprintln!("fake server crashed on purpose");
                    std::process::exit(3);
                }
                publish(&mut writer, &uri, params["textDocument"]["version"].clone(), text);
            }
            "textDocument/didClose" => {
                let uri = params["textDocument"]["uri"].as_str().unwrap_or_default();
                documents.remove(uri);
            }
            "initialized" => {
                ask_for_configuration(&mut writer);
                register_watchers(&mut writer);
            }
            "workspace/didChangeWatchedFiles" => {
                for change in params["changes"].as_array().cloned().unwrap_or_default() {
                    keep_note(&format!("watched {} {}", change["uri"].as_str().unwrap_or_default(), change["type"]));
                }
            }
            "workspace/didChangeConfiguration" => keep_note(&format!("configuration pushed {}", params["settings"])),
            "exit" => std::process::exit(0),
            _ => {}
        }
        let Some(id) = id else {
            continue;
        };
        if message.get("method").is_none() {
            continue;
        }
        let result = answer(&method, &params, &documents, complete_function_calls);
        let _ = write_message(&mut writer, &json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }
}

/// The answer to a request.
fn answer(method: &str, params: &Value, documents: &HashMap<String, String>, complete_function_calls: bool) -> Value {
    match method {
        "initialize" => json!({
            "capabilities": {
                "textDocumentSync": { "openClose": true, "change": 2, "save": { "includeText": false } },
                "completionProvider": { "triggerCharacters": ["."], "resolveProvider": true },
                "hoverProvider": true,
                "definitionProvider": true,
                "typeDefinitionProvider": true,
                "implementationProvider": true,
                "signatureHelpProvider": { "triggerCharacters": ["(", ","], "retriggerCharacters": [")"] },
                "inlayHintProvider": true,
                "referencesProvider": true,
                "documentHighlightProvider": true,
                "renameProvider": { "prepareProvider": true },
                "codeActionProvider": true,
                "documentFormattingProvider": true,
            },
            "serverInfo": { "name": "fake-lsp" },
        }),
        "textDocument/completion" => completion(params, documents),
        "completionItem/resolve" => resolve(params, complete_function_calls),
        "textDocument/hover" => hover(params, documents),
        "textDocument/definition" => json!({
            "uri": params["textDocument"]["uri"],
            "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } },
        }),
        "textDocument/typeDefinition" | "textDocument/implementation" => json!([{
            "uri": params["textDocument"]["uri"],
            "range": { "start": { "line": 1, "character": 0 }, "end": { "line": 1, "character": 2 } },
        }]),
        "textDocument/signatureHelp" => signature_help(params, documents),
        "textDocument/inlayHint" => inlay_hints(params, documents),
        "textDocument/references" => references(params, documents),
        "textDocument/documentHighlight" => highlights(params, documents),
        "textDocument/prepareRename" => prepare_rename(params, documents),
        "textDocument/rename" => rename(params, documents),
        "textDocument/codeAction" => code_actions(params, documents),
        "textDocument/formatting" => formatting(params, documents),
        _ => Value::Null,
    }
}

/// The text of the document a request is about, and the place in it.
fn place_of(params: &Value, documents: &HashMap<String, String>) -> (String, usize, usize) {
    let uri = params["textDocument"]["uri"].as_str().unwrap_or_default();
    let text = documents.get(uri).cloned().unwrap_or_default();
    let line = params["position"]["line"].as_u64().unwrap_or(0) as usize;
    let character = params["position"]["character"].as_u64().unwrap_or(0) as usize;
    (text, line, character)
}

/// The word that touches a column of a line, as UTF-16 columns.
fn word_at(line: &str, character: usize) -> Option<(usize, usize, String)> {
    let units: Vec<(usize, char)> = line
        .chars()
        .scan(0, |at, c| {
            let start = *at;
            *at += c.len_utf16();
            Some((start, c))
        })
        .collect();
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let index = units.iter().position(|(start, _)| *start >= character).unwrap_or(units.len());
    let mut from = index;
    if from == units.len() || !is_word(units[from].1) {
        if from == 0 || !is_word(units[from - 1].1) {
            return None;
        }
        from -= 1;
    }
    let mut start = from;
    while start > 0 && is_word(units[start - 1].1) {
        start -= 1;
    }
    let mut end = from;
    while end < units.len() && is_word(units[end].1) {
        end += 1;
    }
    let word: String = units[start..end].iter().map(|(_, c)| *c).collect();
    let from_unit = units[start].0;
    let to_unit = units.get(end).map(|(at, _)| *at).unwrap_or_else(|| line.encode_utf16().count());
    Some((from_unit, to_unit, word))
}

/// Every whole-word occurrence of `word` in a text, as `(line, from, to)` in UTF-16 columns.
fn occurrences(text: &str, word: &str) -> Vec<(usize, usize, usize)> {
    let mut found = Vec::new();
    for (line_number, line) in text.split('\n').enumerate() {
        let mut character = 0;
        while character <= line.encode_utf16().count() {
            if let Some((from, to, candidate)) = word_at(line, character) {
                if candidate == word && from >= character {
                    found.push((line_number, from, to));
                }
                character = to.max(character + 1);
            } else {
                character += 1;
            }
        }
    }
    found
}

/// A range on one line, as the protocol writes it.
fn range_json(line: usize, from: usize, to: usize) -> Value {
    json!({ "start": { "line": line, "character": from }, "end": { "line": line, "character": to } })
}

/// Two signatures of `alpha`, with the parameter after the commas before the cursor active.
fn signature_help(params: &Value, documents: &HashMap<String, String>) -> Value {
    let (text, line, character) = place_of(params, documents);
    let line_text = text.lines().nth(line).unwrap_or_default();
    let before = &line_text[..unit_to_byte(line_text, character)];
    let Some(open) = before.rfind('(') else {
        return Value::Null;
    };
    if before[open..].contains(')') {
        return Value::Null;
    }
    let active = before[open..].matches(',').count();
    json!({
        "signatures": [
            { "label": "alpha(first: number, second: string)", "documentation": "Calls alpha.",
              "parameters": [{ "label": "first: number", "documentation": "The first." }, { "label": [21, 35] }] },
            { "label": "alpha(only: boolean)", "parameters": [{ "label": "only: boolean" }] },
        ],
        "activeSignature": 0,
        "activeParameter": active,
    })
}

/// A hint after the first word of every line in the range.
fn inlay_hints(params: &Value, documents: &HashMap<String, String>) -> Value {
    let uri = params["textDocument"]["uri"].as_str().unwrap_or_default();
    let text = documents.get(uri).cloned().unwrap_or_default();
    let first = params["range"]["start"]["line"].as_u64().unwrap_or(0) as usize;
    let last = params["range"]["end"]["line"].as_u64().unwrap_or(0) as usize;
    let mut hints = Vec::new();
    for (number, line) in text.split('\n').enumerate().filter(|(number, _)| (first..=last).contains(number)) {
        if let Some((_, to, _)) = word_at(line, 0) {
            hints
                .push(json!({ "position": { "line": number, "character": to }, "label": ": T", "paddingLeft": false }));
        }
    }
    json!(hints)
}

/// Every occurrence of the word at the place, in every document.
fn references(params: &Value, documents: &HashMap<String, String>) -> Value {
    let (text, line, character) = place_of(params, documents);
    let Some((_, _, word)) = word_at(text.lines().nth(line).unwrap_or_default(), character) else {
        return Value::Null;
    };
    let mut locations = Vec::new();
    let mut uris: Vec<&String> = documents.keys().collect();
    uris.sort();
    for uri in uris {
        for (line, from, to) in occurrences(&documents[uri], &word) {
            locations.push(json!({ "uri": uri, "range": range_json(line, from, to) }));
        }
    }
    json!(locations)
}

/// The occurrences of the word at the place in its own document.
fn highlights(params: &Value, documents: &HashMap<String, String>) -> Value {
    let (text, line, character) = place_of(params, documents);
    let Some((_, _, word)) = word_at(text.lines().nth(line).unwrap_or_default(), character) else {
        return json!([]);
    };
    let found: Vec<Value> = occurrences(&text, &word)
        .into_iter()
        .map(|(line, from, to)| json!({ "range": range_json(line, from, to), "kind": 1 }))
        .collect();
    json!(found)
}

/// The word at the place, which can be renamed.
fn prepare_rename(params: &Value, documents: &HashMap<String, String>) -> Value {
    let (text, line, character) = place_of(params, documents);
    match word_at(text.lines().nth(line).unwrap_or_default(), character) {
        Some((from, to, word)) => json!({ "range": range_json(line, from, to), "placeholder": word }),
        None => Value::Null,
    }
}

/// A workspace edit that gives every occurrence of the word, in every document, the new name.
fn rename(params: &Value, documents: &HashMap<String, String>) -> Value {
    let (text, line, character) = place_of(params, documents);
    let Some((_, _, word)) = word_at(text.lines().nth(line).unwrap_or_default(), character) else {
        return Value::Null;
    };
    let new_name = params["newName"].as_str().unwrap_or_default();
    let mut changes = serde_json::Map::new();
    for (uri, text) in documents {
        let edits: Vec<Value> = occurrences(text, &word)
            .into_iter()
            .map(|(line, from, to)| json!({ "range": range_json(line, from, to), "newText": new_name }))
            .collect();
        if !edits.is_empty() {
            changes.insert(uri.clone(), json!(edits));
        }
    }
    json!({ "changes": changes })
}

/// A fix for every diagnostic in the request, and a refactor that runs a command.
fn code_actions(params: &Value, documents: &HashMap<String, String>) -> Value {
    let uri = params["textDocument"]["uri"].as_str().unwrap_or_default();
    let _ = documents;
    let mut actions = Vec::new();
    for diagnostic in params["context"]["diagnostics"].as_array().into_iter().flatten() {
        actions.push(json!({
            "title": "Replace BAD with GOOD",
            "kind": "quickfix",
            "isPreferred": true,
            "diagnostics": [diagnostic],
            "edit": { "changes": { uri: [{ "range": diagnostic["range"], "newText": "GOOD" }] } },
        }));
    }
    actions.push(json!({ "title": "Extract function", "kind": "refactor.extract", "command": { "title": "Extract function", "command": "fake.extract" } }));
    json!(actions)
}

/// Edits that strip the white space at the end of lines.
fn formatting(params: &Value, documents: &HashMap<String, String>) -> Value {
    let uri = params["textDocument"]["uri"].as_str().unwrap_or_default();
    let text = documents.get(uri).cloned().unwrap_or_default();
    let mut edits = Vec::new();
    for (number, line) in text.split('\n').enumerate() {
        let trimmed = line.trim_end();
        if trimmed.len() != line.len() {
            let from = trimmed.encode_utf16().count();
            let to = line.encode_utf16().count();
            edits.push(json!({ "range": range_json(number, from, to), "newText": "" }));
        }
    }
    json!(edits)
}

/// The item with its documentation and signature added, and as a snippet with the parameters
/// of a function call when the client asked for those.
fn resolve(item: &Value, complete_function_calls: bool) -> Value {
    let label = item["label"].as_str().unwrap_or_default();
    let mut resolved = item.clone();
    resolved["documentation"] = json!({ "kind": "markdown", "value": format!("docs for **{label}**") });
    if complete_function_calls && item["kind"] == 3 {
        let snippet = format!("{label}(${{1:value}})$0");
        resolved["insertTextFormat"] = json!(2);
        resolved["insertText"] = json!(snippet);
        resolved["textEdit"]["newText"] = json!(snippet);
    }
    resolved
}

/// Words to complete at the word before the position, replacing it.
fn completion(params: &Value, documents: &HashMap<String, String>) -> Value {
    let uri = params["textDocument"]["uri"].as_str().unwrap_or_default();
    let text = documents.get(uri).cloned().unwrap_or_default();
    let line = params["position"]["line"].as_u64().unwrap_or(0) as usize;
    let character = params["position"]["character"].as_u64().unwrap_or(0) as usize;
    let line_text = text.lines().nth(line).unwrap_or_default();
    let cursor = unit_to_byte(line_text, character);
    let start = line_text[..cursor]
        .char_indices()
        .rev()
        .take_while(|(_, c)| c.is_alphanumeric() || *c == '_')
        .last()
        .map(|(index, _)| index)
        .unwrap_or(cursor);
    let start_units: usize = line_text[..start].encode_utf16().count();
    let range =
        json!({ "start": { "line": line, "character": start_units }, "end": { "line": line, "character": character } });
    let words = [("alpha", 3, "fn alpha()"), ("beta", 6, "field beta"), ("gamma_ray", 2, "method")];
    let items: Vec<Value> = words
        .iter()
        .map(|(word, kind, detail)| {
            json!({ "label": word, "kind": kind, "detail": detail, "textEdit": { "range": range, "newText": word } })
        })
        .collect();
    json!({ "isIncomplete": false, "items": items })
}

/// A hover that says which line it is for.
fn hover(params: &Value, documents: &HashMap<String, String>) -> Value {
    let uri = params["textDocument"]["uri"].as_str().unwrap_or_default();
    let line = params["position"]["line"].as_u64().unwrap_or(0) as usize;
    let text = documents.get(uri).cloned().unwrap_or_default();
    let line_text = text.lines().nth(line).unwrap_or_default();
    json!({ "contents": { "kind": "markdown", "value": format!("**hover** line {line}: `{line_text}`") } })
}

/// Sends a request for configuration; the answer is reported to the client in the main loop.
fn ask_for_configuration(writer: &mut impl std::io::Write) {
    let items = json!([{ "section": "fake" }, { "section": "rust-analyzer" }, { "section": "typescript" }]);
    let request =
        json!({ "jsonrpc": "2.0", "id": 9000, "method": "workspace/configuration", "params": { "items": items } });
    let _ = write_message(writer, &request);
}

/// Asks to hear about changes to files ending in `.watched`.
fn register_watchers(writer: &mut impl std::io::Write) {
    let options = json!({ "watchers": [{ "globPattern": "**/*.watched" }] });
    let registration =
        json!({ "id": "watch-1", "method": "workspace/didChangeWatchedFiles", "registerOptions": options });
    let request = json!({ "jsonrpc": "2.0", "id": 9001, "method": "client/registerCapability", "params": { "registrations": [registration] } });
    let _ = write_message(writer, &request);
}

/// Appends a line to `fake-lsp.log` in the server's working directory, for a test to read.
fn keep_note(line: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open("fake-lsp.log") {
        let _ = writeln!(file, "{line}");
    }
}

/// Tells the client, as a log message, what it answered to the configuration request.
fn report_configuration(writer: &mut impl std::io::Write, answer: &Value) {
    keep_note(&format!("configuration answered {}", answer["result"]));
    let log = json!({ "jsonrpc": "2.0", "method": "window/logMessage", "params": { "type": 3, "message": format!("configuration answered {}", answer["result"]) } });
    let _ = write_message(writer, &log);
}

/// Publishes an error for every `BAD` in the text.
fn publish(writer: &mut impl std::io::Write, uri: &str, version: Value, text: &str) {
    let mut diagnostics = Vec::new();
    for (line_number, line) in text.split('\n').enumerate() {
        for (byte, _) in line.match_indices("BAD") {
            let start: usize = line[..byte].encode_utf16().count();
            diagnostics.push(json!({
                "range": { "start": { "line": line_number, "character": start }, "end": { "line": line_number, "character": start + 3 } },
                "severity": 1,
                "source": "fake",
                "message": "found BAD",
            }));
        }
    }
    let params = json!({ "uri": uri, "version": version, "diagnostics": diagnostics });
    let _ = write_message(
        writer,
        &json!({ "jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": params }),
    );
}

/// Applies one change event to a text.
fn apply_change(text: &mut String, change: &Value) {
    let Some(range) = change.get("range") else {
        *text = change["text"].as_str().unwrap_or_default().to_string();
        return;
    };
    let start = position_to_byte(text, &range["start"]);
    let end = position_to_byte(text, &range["end"]);
    text.replace_range(start..end, change["text"].as_str().unwrap_or_default());
}

/// The byte offset of a position, counting columns in UTF-16 units.
fn position_to_byte(text: &str, position: &Value) -> usize {
    let line = position["line"].as_u64().unwrap_or(0) as usize;
    let character = position["character"].as_u64().unwrap_or(0) as usize;
    let mut offset = 0;
    for (index, line_text) in text.split_inclusive('\n').enumerate() {
        if index == line {
            let content = line_text.strip_suffix('\n').unwrap_or(line_text);
            return offset + unit_to_byte(content, character);
        }
        offset += line_text.len();
    }
    text.len()
}

/// The byte offset in a line of a column in UTF-16 units.
fn unit_to_byte(line: &str, units: usize) -> usize {
    let mut seen = 0;
    for (index, character) in line.char_indices() {
        if seen >= units {
            return index;
        }
        seen += character.len_utf16();
    }
    line.len()
}
