//! What the editor answers a server that asks for its settings: sensible defaults for each
//! server, and the switches Grove's own settings turn (inlay hints). A server asks by section,
//! such as `typescript` or `rust-analyzer`; a section nobody has opinions on is null.

use serde_json::{Value, json};

/// The settings the editor's own switches change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Switches {
    pub inlay_hints: bool,
}

/// The answer to one configuration item, naming the section the server wants.
pub fn section(server: &str, section: &str, switches: Switches) -> Value {
    let all = all_sections(server, switches);
    if section.is_empty() {
        return all;
    }
    let mut value = &all;
    for part in section.split('.') {
        match value.get(part) {
            Some(inner) => value = inner,
            None => return Value::Null,
        }
    }
    value.clone()
}

/// Every section the server knows of, which is also what is pushed in `didChangeConfiguration`.
pub fn all_sections(server: &str, switches: Switches) -> Value {
    match server {
        "typescript" => {
            let language = typescript_settings(switches);
            // `completions` is where typescript-language-server reads its call completion from.
            json!({
                "typescript": language,
                "javascript": language,
                "vtsls": { "autoUseWorkspaceTsdk": true },
                "completions": { "completeFunctionCalls": true },
            })
        }
        "rust-analyzer" => json!({
            "rust-analyzer": {
                "inlayHints": {
                    "typeHints": { "enable": switches.inlay_hints },
                    "parameterHints": { "enable": switches.inlay_hints },
                    "chainingHints": { "enable": switches.inlay_hints },
                    "closingBraceHints": { "enable": false },
                },
            },
        }),
        "gopls" => {
            let on = switches.inlay_hints;
            json!({ "gopls": { "hints": {
                "assignVariableTypes": on, "compositeLiteralFields": on, "compositeLiteralTypes": on,
                "constantValues": on, "functionTypeParameters": on, "parameterNames": on, "rangeVariableTypes": on,
            } } })
        }
        "lua-language-server" => {
            json!({ "Lua": { "hint": { "enable": switches.inlay_hints }, "telemetry": { "enable": false } } })
        }
        _ => json!({}),
    }
}

/// The `initializationOptions` of a server, for those that read their preferences from there.
pub fn initialization_options(server: &str, switches: Switches) -> Value {
    if server != "typescript" {
        return Value::Null;
    }
    let hints = if switches.inlay_hints { "literals" } else { "none" };
    let enabled = switches.inlay_hints;
    json!({
        "preferences": {
            "providePrefixAndSuffixTextForRename": false,
            "includeInlayParameterNameHints": hints,
            "includeInlayParameterNameHintsWhenArgumentMatchesName": false,
            "includeInlayFunctionParameterTypeHints": enabled,
            "includeInlayVariableTypeHints": enabled,
            "includeInlayVariableTypeHintsWhenTypeMatchesName": false,
            "includeInlayPropertyDeclarationTypeHints": enabled,
            "includeInlayFunctionLikeReturnTypeHints": enabled,
            "includeInlayEnumMemberValueHints": enabled,
        },
    })
}

/// TypeScript's and JavaScript's settings, in the shape vtsls reads.
fn typescript_settings(switches: Switches) -> Value {
    let hints = if switches.inlay_hints { "literals" } else { "none" };
    let enabled = switches.inlay_hints;
    json!({
        // Rename the symbol itself in every file, not just an alias in the file that imports it.
        "preferences": { "useAliasesForRenames": false },
        // A function completion comes with its parentheses and parameters, as a snippet.
        "suggest": { "completeFunctionCalls": true },
        "inlayHints": {
            "parameterNames": { "enabled": hints, "suppressWhenArgumentMatchesName": true },
            "parameterTypes": { "enabled": enabled },
            "variableTypes": { "enabled": enabled, "suppressWhenTypeMatchesName": true },
            "propertyDeclarationTypes": { "enabled": enabled },
            "functionLikeReturnTypes": { "enabled": enabled },
            "enumMemberValues": { "enabled": enabled },
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON: Switches = Switches { inlay_hints: true };
    const OFF: Switches = Switches { inlay_hints: false };

    #[test]
    fn sections_are_found_by_their_dotted_names() {
        let hints = section("typescript", "typescript.inlayHints.variableTypes.enabled", ON);
        assert_eq!(hints, json!(true));
        assert_eq!(section("typescript", "javascript.inlayHints.variableTypes.enabled", OFF), json!(false));
        assert_eq!(section("rust-analyzer", "rust-analyzer", ON)["inlayHints"]["typeHints"]["enable"], true);
        assert!(section("rust-analyzer", "rust-analyzer.cargo.nothing", ON).is_null());
        assert!(section("css", "css", ON).is_null());
    }

    #[test]
    fn servers_are_asked_to_complete_function_calls() {
        assert_eq!(section("typescript", "typescript.suggest.completeFunctionCalls", OFF), json!(true));
        assert_eq!(section("typescript", "javascript.suggest.completeFunctionCalls", ON), json!(true));
        assert_eq!(section("typescript", "completions.completeFunctionCalls", ON), json!(true));
        assert_eq!(section("typescript", "", ON)["typescript"]["suggest"]["completeFunctionCalls"], true);
        assert!(section("typescript", "typescript.format", ON).is_null());
    }

    #[test]
    fn turning_hints_off_turns_them_off_for_every_server() {
        assert_eq!(section("gopls", "gopls", OFF)["hints"]["parameterNames"], false);
        assert_eq!(section("lua-language-server", "Lua", OFF)["hint"]["enable"], false);
        assert_eq!(initialization_options("typescript", OFF)["preferences"]["includeInlayParameterNameHints"], "none");
        assert!(initialization_options("gopls", ON).is_null());
    }
}
