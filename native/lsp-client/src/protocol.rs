//! The parts of the Language Server Protocol the editor uses, as plain data. Anything the
//! editor does not read stays in a `serde_json::Value`, so a server's extra fields are never lost.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A line and a UTF-16 column, counted from zero.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Position {
    pub line: usize,
    pub character: usize,
}

/// The text between two positions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

/// A replacement of a range of text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub range: Range,
    pub new_text: String,
}

/// A range in a document, named by its URI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Location {
    pub uri: String,
    pub range: Range,
}

/// What a diagnostic's severity number means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
    Information,
    Hint,
}

impl Severity {
    /// The severity a number stands for. A diagnostic without one counts as an error.
    pub fn from_number(number: Option<u8>) -> Severity {
        match number {
            Some(2) => Severity::Warning,
            Some(3) => Severity::Information,
            Some(4) => Severity::Hint,
            _ => Severity::Error,
        }
    }
}

/// A problem a server found in a document.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub range: Range,
    #[serde(default)]
    pub severity: Option<u8>,
    #[serde(default)]
    pub code: Option<Value>,
    #[serde(default)]
    pub source: Option<String>,
    pub message: String,
    #[serde(default)]
    pub tags: Vec<u8>,
}

/// What `textDocument/publishDiagnostics` carries.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PublishDiagnostics {
    pub uri: String,
    #[serde(default)]
    pub version: Option<i64>,
    pub diagnostics: Vec<Diagnostic>,
}

/// How the server wants to be told about changes to the text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncKind {
    /// The server does not want to hear about changes.
    None,
    /// The whole text, every time.
    Full,
    /// Only what changed.
    Incremental,
}

/// What a server said it can do when it started, reduced to what the editor asks about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capabilities {
    pub sync: SyncKind,
    pub wants_save: bool,
    pub wants_text_on_save: bool,
    pub hover: bool,
    pub definition: bool,
    pub completion: bool,
    pub completion_resolve: bool,
    pub trigger_characters: Vec<String>,
    pub signature_help: bool,
    pub signature_trigger_characters: Vec<String>,
    pub signature_retrigger_characters: Vec<String>,
    pub inlay_hints: bool,
    pub references: bool,
    pub type_definition: bool,
    pub implementation: bool,
    pub rename: bool,
    /// Whether the server checks a rename with `prepareRename` before it is asked to do it.
    pub prepare_rename: bool,
    pub code_action: bool,
    pub code_action_resolve: bool,
    pub formatting: bool,
    pub document_highlight: bool,
}

impl Capabilities {
    /// Reads the `capabilities` of an initialize result.
    pub fn from_json(capabilities: &Value) -> Capabilities {
        let sync = &capabilities["textDocumentSync"];
        let (kind, save) = match sync {
            Value::Number(number) => (number.as_u64(), Value::Null),
            Value::Object(_) => (sync["change"].as_u64(), sync["save"].clone()),
            _ => (None, Value::Null),
        };
        let completion = &capabilities["completionProvider"];
        let signature = &capabilities["signatureHelpProvider"];
        Capabilities {
            sync: match kind {
                Some(1) => SyncKind::Full,
                Some(2) => SyncKind::Incremental,
                _ => SyncKind::None,
            },
            wants_save: !save.is_null() && save != Value::Bool(false),
            wants_text_on_save: save["includeText"].as_bool().unwrap_or(false),
            hover: is_provided(&capabilities["hoverProvider"]),
            definition: is_provided(&capabilities["definitionProvider"]),
            completion: completion.is_object(),
            completion_resolve: completion["resolveProvider"].as_bool().unwrap_or(false),
            trigger_characters: strings_of(&completion["triggerCharacters"]),
            signature_help: is_provided(signature),
            signature_trigger_characters: strings_of(&signature["triggerCharacters"]),
            signature_retrigger_characters: strings_of(&signature["retriggerCharacters"]),
            inlay_hints: is_provided(&capabilities["inlayHintProvider"]),
            references: is_provided(&capabilities["referencesProvider"]),
            type_definition: is_provided(&capabilities["typeDefinitionProvider"]),
            implementation: is_provided(&capabilities["implementationProvider"]),
            rename: is_provided(&capabilities["renameProvider"]),
            prepare_rename: capabilities["renameProvider"]["prepareProvider"].as_bool().unwrap_or(false),
            code_action: is_provided(&capabilities["codeActionProvider"]),
            code_action_resolve: capabilities["codeActionProvider"]["resolveProvider"].as_bool().unwrap_or(false),
            formatting: is_provided(&capabilities["documentFormattingProvider"]),
            document_highlight: is_provided(&capabilities["documentHighlightProvider"]),
        }
    }
}

/// The strings in a JSON list, or none for anything else.
fn strings_of(list: &Value) -> Vec<String> {
    let Some(entries) = list.as_array() else {
        return Vec::new();
    };
    entries.iter().filter_map(|entry| entry.as_str().map(str::to_string)).collect()
}

/// Whether a provider entry says the feature exists: `true` or an options object.
fn is_provided(provider: &Value) -> bool {
    provider.as_bool().unwrap_or(false) || provider.is_object()
}

/// An error a server answered a request with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResponseError {
    pub code: i64,
    pub message: String,
}

/// The code a server answers with for a request it was asked to cancel.
pub const REQUEST_CANCELLED: i64 = -32800;
/// The code a server answers with for a document that changed under a request.
pub const CONTENT_MODIFIED: i64 = -32801;
/// The code for a method the receiver does not have.
pub const METHOD_NOT_FOUND: i64 = -32601;

impl ResponseError {
    /// An error with the code for an internal failure.
    pub fn internal(message: impl Into<String>) -> ResponseError {
        ResponseError { code: -32603, message: message.into() }
    }

    /// Reads the `error` member of a response.
    pub fn from_json(error: &Value) -> ResponseError {
        ResponseError {
            code: error["code"].as_i64().unwrap_or(-32603),
            message: error["message"].as_str().unwrap_or("the server answered with an error").to_string(),
        }
    }

    /// Whether the server only gave up on a request that no longer matters: the person typed on,
    /// or the request was cancelled.
    pub fn is_stale(&self) -> bool {
        self.code == REQUEST_CANCELLED || self.code == CONTENT_MODIFIED
    }
}

/// Where a go-to request leads: a place in a file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub uri: String,
    pub range: Range,
}

/// Reads the answer to a definition request, which may be nothing, one location, a list of
/// locations or a list of location links.
pub fn parse_targets(result: &Value) -> Vec<Target> {
    let entries: Vec<&Value> = match result {
        Value::Array(list) => list.iter().collect(),
        Value::Object(_) => vec![result],
        _ => Vec::new(),
    };
    entries.into_iter().filter_map(target_of).collect()
}

/// One location or location link as a target.
fn target_of(entry: &Value) -> Option<Target> {
    if let Some(uri) = entry["targetUri"].as_str() {
        let range = entry.get("targetSelectionRange").or_else(|| entry.get("targetRange"))?;
        return Some(Target { uri: uri.to_string(), range: serde_json::from_value(range.clone()).ok()? });
    }
    let location: Location = serde_json::from_value(entry.clone()).ok()?;
    Some(Target { uri: location.uri, range: location.range })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn capabilities_are_read_from_either_sync_form() {
        let simple = Capabilities::from_json(&json!({ "textDocumentSync": 2, "hoverProvider": true }));
        assert_eq!(simple.sync, SyncKind::Incremental);
        assert!(simple.hover);
        assert!(!simple.completion);
        let detailed = Capabilities::from_json(&json!({
            "textDocumentSync": { "openClose": true, "change": 1, "save": { "includeText": true } },
            "completionProvider": { "triggerCharacters": [".", ":"], "resolveProvider": true },
            "definitionProvider": { "workDoneProgress": true },
        }));
        assert_eq!(detailed.sync, SyncKind::Full);
        assert!(detailed.wants_save && detailed.wants_text_on_save);
        assert!(detailed.completion && detailed.completion_resolve && detailed.definition);
        assert_eq!(detailed.trigger_characters, vec![".", ":"]);
        assert_eq!(Capabilities::from_json(&json!({})).sync, SyncKind::None);
    }

    #[test]
    fn the_features_around_the_cursor_are_read_from_their_providers() {
        let capabilities = Capabilities::from_json(&json!({
            "signatureHelpProvider": { "triggerCharacters": ["(", ","], "retriggerCharacters": [")"] },
            "inlayHintProvider": { "resolveProvider": false },
            "referencesProvider": true,
            "renameProvider": { "prepareProvider": true },
            "codeActionProvider": { "resolveProvider": true },
            "documentFormattingProvider": true,
            "documentHighlightProvider": true,
            "typeDefinitionProvider": true,
            "implementationProvider": { "workDoneProgress": true },
        }));
        assert!(capabilities.signature_help && capabilities.inlay_hints && capabilities.references);
        assert_eq!(capabilities.signature_trigger_characters, vec!["(", ","]);
        assert_eq!(capabilities.signature_retrigger_characters, vec![")"]);
        assert!(capabilities.rename && capabilities.prepare_rename);
        assert!(capabilities.code_action && capabilities.code_action_resolve);
        assert!(capabilities.formatting && capabilities.document_highlight);
        assert!(capabilities.type_definition && capabilities.implementation);
        let none = Capabilities::from_json(&json!({ "renameProvider": true, "codeActionProvider": false }));
        assert!(none.rename && !none.prepare_rename && !none.code_action && !none.signature_help);
    }

    #[test]
    fn severities_default_to_error() {
        assert_eq!(Severity::from_number(None), Severity::Error);
        assert_eq!(Severity::from_number(Some(2)), Severity::Warning);
        assert_eq!(Severity::from_number(Some(4)), Severity::Hint);
    }

    #[test]
    fn definition_answers_come_in_four_shapes() {
        let range = json!({ "start": { "line": 1, "character": 2 }, "end": { "line": 1, "character": 5 } });
        assert!(parse_targets(&Value::Null).is_empty());
        let one = parse_targets(&json!({ "uri": "file:///a.ts", "range": range }));
        assert_eq!(one[0].range.start, Position { line: 1, character: 2 });
        let many = parse_targets(
            &json!([{ "uri": "file:///a.ts", "range": range }, { "uri": "file:///b.ts", "range": range }]),
        );
        assert_eq!(many.len(), 2);
        let link = parse_targets(&json!([{ "targetUri": "file:///c.ts", "targetRange": range,
            "targetSelectionRange": { "start": { "line": 3, "character": 0 }, "end": { "line": 3, "character": 1 } } }]));
        assert_eq!(link[0].uri, "file:///c.ts");
        assert_eq!(link[0].range.start.line, 3);
    }
}
