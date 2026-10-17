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

/// The settings the editor gives servers that ask for them with `workspace/configuration`. Function
/// completions come with their parentheses and parameters as a snippet: `vtsls` reads that from
/// `typescript` and `javascript`, and `typescript-language-server` from `completions`.
fn workspace_settings() -> Value {
    json!({
        "typescript": { "suggest": { "completeFunctionCalls": true } },
        "javascript": { "suggest": { "completeFunctionCalls": true } },
        "completions": { "completeFunctionCalls": true },
    })
}

/// The answer to one item of a `workspace/configuration` request: the settings under a dotted
/// section name, all of them for an empty section, and null for one the editor has nothing for.
pub fn configuration_for(section: &str) -> Value {
    let mut settings = workspace_settings();
    if section.is_empty() {
        return settings;
    }
    for name in section.split('.') {
        let Some(inner) = settings.get_mut(name) else {
            return Value::Null;
        };
        settings = inner.take();
    }
    settings
}

/// What the editor can do with what a server sends: the completion features the panel shows,
/// markdown in hovers and documentation, and the diagnostics and progress it draws.
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
            "publishDiagnostics": { "relatedInformation": false, "versionSupport": true, "tagSupport": { "valueSet": [1, 2] } },
        },
        "window": { "workDoneProgress": true },
        "workspace": { "configuration": true, "workspaceFolders": true, "applyEdit": false },
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

    #[test]
    fn servers_are_asked_to_complete_function_calls() {
        assert_eq!(configuration_for("typescript")["suggest"]["completeFunctionCalls"], true);
        assert_eq!(configuration_for("javascript.suggest.completeFunctionCalls"), true);
        assert_eq!(configuration_for("")["completions"]["completeFunctionCalls"], true);
        assert_eq!(configuration_for("python.analysis"), Value::Null);
        assert_eq!(configuration_for("typescript.format"), Value::Null);
    }
}
