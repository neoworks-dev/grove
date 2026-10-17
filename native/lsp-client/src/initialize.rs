//! What the editor tells a server about itself when it starts one.

use std::path::Path;

use serde_json::{Value, json};

use crate::uri::uri_from_path;

/// The parameters of the initialize request for the workspace at `root`.
pub fn initialize_params(root: &Path, initialization_options: Value) -> Value {
    let root_uri = uri_from_path(root);
    let name = root.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    json!({
        "processId": std::process::id(),
        "clientInfo": { "name": "Grove", "version": env!("CARGO_PKG_VERSION") },
        "locale": "en",
        "rootPath": root.display().to_string(),
        "rootUri": root_uri,
        "workspaceFolders": [{ "uri": root_uri, "name": name }],
        "initializationOptions": initialization_options,
        "capabilities": client_capabilities(),
        "trace": "off",
    })
}

/// What the editor can do with what a server sends: the completion features the panel shows,
/// markdown in hovers and documentation, the diagnostics and progress it draws, signature help,
/// inlay hints, references, rename, code actions and the edits a server asks to be applied.
fn client_capabilities() -> Value {
    json!({
        "general": { "positionEncodings": ["utf-16"] },
        "textDocument": {
            "synchronization": { "dynamicRegistration": false, "didSave": true, "willSave": false },
            "completion": {
                "contextSupport": true,
                "completionItem": {
                    "snippetSupport": true,
                    "commitCharactersSupport": false,
                    "documentationFormat": ["markdown", "plaintext"],
                    "deprecatedSupport": true,
                    "preselectSupport": true,
                    "insertReplaceSupport": true,
                    "labelDetailsSupport": true,
                    "tagSupport": { "valueSet": [1] },
                    "resolveSupport": { "properties": ["documentation", "detail", "additionalTextEdits"] },
                },
                "completionItemKind": { "valueSet": (1..=25).collect::<Vec<u32>>() },
                "completionList": { "itemDefaults": ["editRange", "insertTextFormat", "insertTextMode", "data"] },
            },
            "hover": { "contentFormat": ["markdown", "plaintext"] },
            "definition": { "linkSupport": true },
            "typeDefinition": { "linkSupport": true },
            "implementation": { "linkSupport": true },
            "references": {},
            "documentHighlight": {},
            "signatureHelp": {
                "contextSupport": true,
                "signatureInformation": {
                    "documentationFormat": ["markdown", "plaintext"],
                    "parameterInformation": { "labelOffsetSupport": true },
                    "activeParameterSupport": true,
                },
            },
            "inlayHint": { "resolveSupport": { "properties": [] } },
            "rename": { "prepareSupport": true, "prepareSupportDefaultBehavior": 1 },
            "codeAction": {
                "isPreferredSupport": true,
                "codeActionLiteralSupport": {
                    "codeActionKind": {
                        "valueSet": ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"],
                    },
                },
                "resolveSupport": { "properties": ["edit"] },
            },
            "formatting": {},
            "publishDiagnostics": { "relatedInformation": false, "versionSupport": true, "tagSupport": { "valueSet": [1, 2] } },
        },
        "window": { "workDoneProgress": true },
        "workspace": {
            "configuration": true,
            "workspaceFolders": true,
            "applyEdit": true,
            "workspaceEdit": { "documentChanges": true },
            "didChangeConfiguration": { "dynamicRegistration": false },
            "didChangeWatchedFiles": { "dynamicRegistration": true },
            "inlayHint": { "refreshSupport": true },
            "executeCommand": { "dynamicRegistration": false },
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_workspace_is_named_by_its_directory() {
        let params = initialize_params(Path::new("/tmp/my project"), Value::Null);
        assert_eq!(params["rootUri"], "file:///tmp/my%20project");
        assert_eq!(params["workspaceFolders"][0]["name"], "my project");
        assert_eq!(params["capabilities"]["textDocument"]["completion"]["completionItem"]["snippetSupport"], true);
    }
}
