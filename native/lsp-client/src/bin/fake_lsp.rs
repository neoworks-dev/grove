//! A small language server for the tests: it keeps the text of the documents it is told about,
//! reports every `BAD` in them as an error, completes a fixed list of words, answers hover and
//! definition, and ends when a document contains `CRASH`. It applies changes with its own
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
    while let Ok(Some(message)) = read_message(&mut reader) {
        if message.get("method").is_none() && message["id"] == 9000 {
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
            "initialized" => ask_for_configuration(&mut writer),
            "exit" => std::process::exit(0),
            _ => {}
        }
        let Some(id) = id else {
            continue;
        };
        if message.get("method").is_none() {
            continue;
        }
        let result = answer(&method, &params, &documents);
        let _ = write_message(&mut writer, &json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }
}

/// The answer to a request.
fn answer(method: &str, params: &Value, documents: &HashMap<String, String>) -> Value {
    match method {
        "initialize" => json!({
            "capabilities": {
                "textDocumentSync": { "openClose": true, "change": 2, "save": { "includeText": false } },
                "completionProvider": { "triggerCharacters": ["."], "resolveProvider": true },
                "hoverProvider": true,
                "definitionProvider": true,
            },
            "serverInfo": { "name": "fake-lsp" },
        }),
        "textDocument/completion" => completion(params, documents),
        "completionItem/resolve" => {
            let mut item = params.clone();
            item["documentation"] = json!({ "kind": "markdown", "value": format!("docs for **{}**", params["label"].as_str().unwrap_or_default()) });
            item
        }
        "textDocument/hover" => hover(params, documents),
        "textDocument/definition" => json!({
            "uri": params["textDocument"]["uri"],
            "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } },
        }),
        _ => Value::Null,
    }
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
    let request = json!({ "jsonrpc": "2.0", "id": 9000, "method": "workspace/configuration", "params": { "items": [{ "section": "fake" }] } });
    let _ = write_message(writer, &request);
}

/// Tells the client, as a log message, what it answered to the configuration request.
fn report_configuration(writer: &mut impl std::io::Write, answer: &Value) {
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
