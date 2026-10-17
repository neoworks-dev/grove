//! Signature help: the signatures a call could match, and which parameter the cursor is on.

use std::ops::Range;

use serde_json::Value;

use crate::completion::documentation_of;

/// One parameter of a signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parameter {
    /// The bytes of the signature's label that name the parameter, when they can be found.
    pub label_range: Option<Range<usize>>,
    pub documentation: Option<String>,
}

/// One way to call the function.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signature {
    pub label: String,
    pub documentation: Option<String>,
    pub parameters: Vec<Parameter>,
    /// The parameter this signature says is active, which overrides the help's own.
    pub active_parameter: Option<usize>,
}

/// What a signature help request answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignatureHelp {
    pub signatures: Vec<Signature>,
    pub active_signature: usize,
    pub active_parameter: Option<usize>,
}

impl SignatureHelp {
    /// Reads the answer to a request. None when the server has no signature for the place.
    pub fn parse(result: &Value) -> Option<SignatureHelp> {
        let entries = result["signatures"].as_array()?;
        let signatures: Vec<Signature> = entries.iter().filter_map(parse_signature).collect();
        if signatures.is_empty() {
            return None;
        }
        let active_signature = result["activeSignature"].as_u64().unwrap_or(0) as usize;
        Some(SignatureHelp {
            active_signature: active_signature.min(signatures.len() - 1),
            active_parameter: result["activeParameter"].as_u64().map(|index| index as usize),
            signatures,
        })
    }

    /// The signature shown, which `choice` may have moved off the one the server preferred.
    pub fn signature(&self, choice: usize) -> &Signature {
        &self.signatures[choice.min(self.signatures.len() - 1)]
    }

    /// The index of the parameter the cursor is on in a signature, if there is one.
    pub fn parameter_of(&self, signature: &Signature) -> Option<usize> {
        let index = signature.active_parameter.or(self.active_parameter)?;
        if index < signature.parameters.len() { Some(index) } else { None }
    }
}

/// One signature of an answer.
fn parse_signature(entry: &Value) -> Option<Signature> {
    let label = entry["label"].as_str()?.to_string();
    let mut parameters = Vec::new();
    let mut searched_from = 0;
    for parameter in entry["parameters"].as_array().into_iter().flatten() {
        let label_range = parameter_range(&label, &parameter["label"], searched_from);
        if let Some(range) = &label_range {
            searched_from = range.end;
        }
        let documentation = parameter.get("documentation").and_then(documentation_of);
        parameters.push(Parameter { label_range, documentation });
    }
    Some(Signature {
        documentation: entry.get("documentation").and_then(documentation_of),
        active_parameter: entry["activeParameter"].as_u64().map(|index| index as usize),
        label,
        parameters,
    })
}

/// Where a parameter is in its signature's label: a pair of UTF-16 offsets into it, or a text
/// that is looked for after the previous parameter.
fn parameter_range(label: &str, parameter: &Value, searched_from: usize) -> Option<Range<usize>> {
    if let Some(pair) = parameter.as_array() {
        let start = byte_of_utf16(label, pair.first()?.as_u64()? as usize);
        let end = byte_of_utf16(label, pair.get(1)?.as_u64()? as usize);
        return Some(start..end.max(start));
    }
    let text = parameter.as_str()?;
    let found = label.get(searched_from..)?.find(text)?;
    Some(searched_from + found..searched_from + found + text.len())
}

/// The byte index in a text of a UTF-16 offset.
fn byte_of_utf16(text: &str, offset: usize) -> usize {
    let mut seen = 0;
    for (index, character) in text.char_indices() {
        if seen >= offset {
            return index;
        }
        seen += character.len_utf16();
    }
    text.len()
}

/// The `context` of a signature help request.
pub fn request_context(trigger: Option<char>, active: Option<&Value>) -> Value {
    let mut context = serde_json::json!({ "isRetrigger": active.is_some() });
    match trigger {
        Some(character) => {
            context["triggerKind"] = 2.into();
            context["triggerCharacter"] = character.to_string().into();
        }
        None => context["triggerKind"] = if active.is_some() { 3.into() } else { 1.into() },
    }
    if let Some(active) = active {
        context["activeSignatureHelp"] = active.clone();
    }
    context
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parameters_are_found_by_offsets_or_by_text() {
        let answer = json!({
            "signatures": [
                { "label": "add(a: number, b: number): number", "parameters": [{ "label": [4, 13] }, { "label": [15, 24] }] },
                { "label": "log(message: string, ...rest)", "parameters": [{ "label": "message: string" }, { "label": "...rest" }] },
            ],
            "activeSignature": 1,
            "activeParameter": 1,
        });
        let help = SignatureHelp::parse(&answer).unwrap();
        let first = &help.signatures[0];
        assert_eq!(&first.label[first.parameters[1].label_range.clone().unwrap()], "b: number");
        let second = help.signature(help.active_signature);
        assert_eq!(&second.label[second.parameters[1].label_range.clone().unwrap()], "...rest");
        assert_eq!(help.parameter_of(second), Some(1));
    }

    #[test]
    fn offsets_count_utf16_units() {
        let answer = json!({ "signatures": [{ "label": "f(é😀: x, y)", "parameters": [{ "label": [2, 8] }] }] });
        let signature = &SignatureHelp::parse(&answer).unwrap().signatures[0];
        assert_eq!(&signature.label[signature.parameters[0].label_range.clone().unwrap()], "é😀: x");
    }

    #[test]
    fn a_signature_overrides_the_active_parameter_and_an_index_past_the_end_selects_none() {
        let answer = json!({
            "signatures": [{ "label": "f(a)", "parameters": [{ "label": "a" }], "activeParameter": 0 }],
            "activeParameter": 3,
        });
        let help = SignatureHelp::parse(&answer).unwrap();
        assert_eq!(help.parameter_of(&help.signatures[0]), Some(0));
        let past =
            json!({ "signatures": [{ "label": "f(a)", "parameters": [{ "label": "a" }] }], "activeParameter": 1 });
        let help = SignatureHelp::parse(&past).unwrap();
        assert_eq!(help.parameter_of(&help.signatures[0]), None);
    }

    #[test]
    fn no_signatures_is_no_help() {
        assert!(SignatureHelp::parse(&Value::Null).is_none());
        assert!(SignatureHelp::parse(&json!({ "signatures": [] })).is_none());
    }

    #[test]
    fn the_request_says_what_asked() {
        assert_eq!(request_context(Some('('), None)["triggerKind"], 2);
        assert_eq!(request_context(None, None)["triggerKind"], 1);
        let active = json!({ "signatures": [] });
        let retrigger = request_context(None, Some(&active));
        assert_eq!((retrigger["triggerKind"].clone(), retrigger["isRetrigger"].clone()), (json!(3), json!(true)));
    }
}
