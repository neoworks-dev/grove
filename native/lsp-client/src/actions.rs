//! Code actions: the fixes and refactors a server offers at a place, and what choosing one does.

use serde_json::{Value, json};

use crate::edits::{WorkspaceEdit, parse_workspace_edit};
use crate::protocol::Diagnostic;

/// One thing the server offers to do.
#[derive(Clone, Debug, PartialEq)]
pub struct CodeAction {
    pub title: String,
    /// `quickfix`, `refactor.extract` and so on, when the server says.
    pub kind: Option<String>,
    pub is_preferred: bool,
    /// Why the action cannot be run right now, when the server lists it anyway.
    pub disabled: Option<String>,
    pub edit: Option<WorkspaceEdit>,
    /// The command to run on the server, as `{ command, arguments }`.
    pub command: Option<Value>,
    /// The entry as the server sent it, to ask it to resolve.
    pub raw: Value,
}

impl CodeAction {
    /// Whether the action is a fix for a problem.
    pub fn is_quick_fix(&self) -> bool {
        self.kind.as_deref().is_some_and(|kind| kind == "quickfix" || kind.starts_with("quickfix."))
    }
}

/// Reads the answer to a code action request: actions, and bare commands which count as actions.
pub fn parse_actions(result: &Value) -> Vec<CodeAction> {
    let Some(list) = result.as_array() else {
        return Vec::new();
    };
    list.iter().filter_map(parse_action).collect()
}

/// One entry of the answer.
fn parse_action(entry: &Value) -> Option<CodeAction> {
    let title = entry["title"].as_str()?.to_string();
    // A bare command has its command's name where an action has an object.
    if entry["command"].is_string() {
        let command = json!({ "command": entry["command"], "arguments": entry["arguments"] });
        return Some(CodeAction {
            title,
            kind: None,
            is_preferred: false,
            disabled: None,
            edit: None,
            command: Some(command),
            raw: entry.clone(),
        });
    }
    let edit = entry.get("edit").filter(|edit| edit.is_object()).map(parse_workspace_edit);
    let command = entry.get("command").filter(|command| command.is_object()).cloned();
    Some(CodeAction {
        title,
        kind: entry["kind"].as_str().map(str::to_string),
        is_preferred: entry["isPreferred"].as_bool().unwrap_or(false),
        disabled: entry["disabled"]["reason"].as_str().map(str::to_string),
        edit,
        command,
        raw: entry.clone(),
    })
}

/// Puts what the server resolved into an action.
pub fn merge_resolved(action: &mut CodeAction, resolved: &Value) {
    if let Some(edit) = resolved.get("edit").filter(|edit| edit.is_object()) {
        action.edit = Some(parse_workspace_edit(edit));
    }
    if let Some(command) = resolved.get("command").filter(|command| command.is_object()) {
        action.command = Some(command.clone());
    }
    action.raw = resolved.clone();
}

/// The parameters of a code action request for a range, with the diagnostics that touch it.
pub fn request_params(uri: &str, range: Value, diagnostics: &[Diagnostic]) -> Value {
    json!({
        "textDocument": { "uri": uri },
        "range": range,
        "context": { "diagnostics": diagnostics, "triggerKind": 1 },
    })
}

/// Orders actions the way a menu shows them: the preferred first, then fixes, then the rest in
/// the order the server gave. Actions that are disabled go last.
pub fn order_for_menu(actions: &mut [CodeAction]) {
    actions.sort_by_key(|action| (action.disabled.is_some(), !action.is_preferred, !action.is_quick_fix()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_and_bare_commands_are_both_offered() {
        let result = json!([
            { "title": "Add import", "kind": "quickfix", "edit": { "changes": { "file:///a.ts": [] } }, "isPreferred": true },
            { "title": "Organize", "command": "organize", "arguments": [1] },
            { "title": "Extract", "kind": "refactor.extract", "command": { "title": "x", "command": "extract" } },
            { "title": "Cannot", "kind": "refactor", "disabled": { "reason": "not here" } },
            { "nonsense": true },
        ]);
        let actions = parse_actions(&result);
        assert_eq!(actions.len(), 4);
        assert!(actions[0].is_quick_fix() && actions[0].is_preferred && actions[0].edit.is_some());
        assert_eq!(actions[1].command.as_ref().unwrap()["command"], "organize");
        assert_eq!(actions[2].command.as_ref().unwrap()["command"], "extract");
        assert_eq!(actions[3].disabled.as_deref(), Some("not here"));
    }

    #[test]
    fn the_menu_lists_preferred_fixes_first_and_disabled_last() {
        let mut actions = parse_actions(&json!([
            { "title": "Disabled", "kind": "quickfix", "disabled": { "reason": "no" } },
            { "title": "Refactor", "kind": "refactor" },
            { "title": "Fix", "kind": "quickfix" },
            { "title": "Best", "kind": "quickfix", "isPreferred": true },
        ]));
        order_for_menu(&mut actions);
        let titles: Vec<&str> = actions.iter().map(|action| action.title.as_str()).collect();
        assert_eq!(titles, vec!["Best", "Fix", "Refactor", "Disabled"]);
    }

    #[test]
    fn resolving_adds_the_edit() {
        let mut actions = parse_actions(&json!([{ "title": "Fix", "kind": "quickfix", "data": 7 }]));
        merge_resolved(
            &mut actions[0],
            &json!({ "title": "Fix", "data": 7, "edit": { "changes": { "file:///a.ts": [
            { "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 0 } }, "newText": "x" }] } } }),
        );
        assert_eq!(actions[0].edit.as_ref().unwrap().edit_count(), 1);
    }
}
