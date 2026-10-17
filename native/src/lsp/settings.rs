//! What the person can switch about language features, set from the app's settings through the
//! `lsp_configure` command.

use serde_json::Value;

/// The switches the language features follow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LspSettings {
    /// Whether inlay hints are shown in the text.
    pub inlay_hints: bool,
    /// Whether saving a file formats it first.
    pub format_on_save: bool,
    /// Whether `eslint_d` lints JavaScript and TypeScript files.
    pub eslint: bool,
}

impl Default for LspSettings {
    /// Everything on, as the bundled nvim had formatting and linting.
    fn default() -> Self {
        LspSettings { inlay_hints: true, format_on_save: true, eslint: true }
    }
}

impl LspSettings {
    /// These settings with whichever of `inlayHints`, `formatOnSave` and `eslint` the arguments
    /// carry applied; the rest stay as they are.
    pub fn updated_from(self, arguments: &Value) -> LspSettings {
        let flag = |name: &str, current: bool| match arguments.get(name).and_then(Value::as_bool) {
            Some(value) => value,
            None => current,
        };
        LspSettings {
            inlay_hints: flag("inlayHints", self.inlay_hints),
            format_on_save: flag("formatOnSave", self.format_on_save),
            eslint: flag("eslint", self.eslint),
        }
    }

    /// The part of the settings that servers are told about.
    pub fn switches(self) -> lsp_client::config::Switches {
        lsp_client::config::Switches { inlay_hints: self.inlay_hints }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn arguments_change_only_the_settings_they_name() {
        let settings = LspSettings::default().updated_from(&json!({ "inlayHints": false, "eslint": "no" }));
        assert!(!settings.inlay_hints);
        assert!(settings.format_on_save && settings.eslint);
    }
}
