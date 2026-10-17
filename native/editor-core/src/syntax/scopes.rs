//! The named scopes around a place in the text: the functions, classes, modules and the like that
//! enclose it, read from the syntax tree. Breadcrumbs show them outer first.
//!
//! What counts as a scope is a list of node types, because the grammars name the same idea
//! differently. A scope is named by its `name` field, except where a language puts the name
//! elsewhere (an `impl` has its type, a function assigned to a variable has the variable).

use ropey::Rope;
use serde::Serialize;
use tree_sitter::Node;

use super::{Layer, Syntax};
use crate::buffer::{Buffer, Position};

/// The longest name a scope is shown with; a longer one is cut.
const MAX_NAME_CHARACTERS: usize = 60;

/// One scope enclosing a place.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Scope {
    /// What sort of thing it is: `function`, `method`, `class`, `interface`, `struct`, `enum`,
    /// `trait`, `impl`, `module` or `macro`.
    pub kind: &'static str,
    pub name: String,
    /// Where the scope starts.
    pub start: Position,
    /// Where the scope ends.
    pub end: Position,
}

impl Syntax {
    /// The scopes that enclose a byte offset, outermost first. Code of another language inside
    /// the file, such as the script of a Svelte file, continues the chain inside the file's own.
    pub fn scopes_at(&self, buffer: &Buffer, byte: usize) -> Vec<Scope> {
        let mut scopes = Vec::new();
        let rope = buffer.rope();
        if let Some(root) = &self.root {
            collect_scopes(root, buffer, rope, byte, &mut scopes);
        }
        for layer in &self.injected {
            if layer.range.start <= byte && byte <= layer.range.end {
                collect_scopes(layer, buffer, rope, byte, &mut scopes);
            }
        }
        scopes
    }
}

/// Adds the scopes of one layer that enclose a byte, outermost first.
fn collect_scopes(layer: &Layer, buffer: &Buffer, rope: &Rope, byte: usize, out: &mut Vec<Scope>) {
    let Some(innermost) = layer.tree.root_node().descendant_for_byte_range(byte, byte) else {
        return;
    };
    let mut chain = Vec::new();
    let mut node = Some(innermost);
    while let Some(current) = node {
        if let Some(scope) = scope_of(current, buffer, rope) {
            chain.push(scope);
        }
        node = current.parent();
    }
    chain.reverse();
    out.extend(chain);
}

/// The scope a node is, if it is one that has a name.
fn scope_of(node: Node, buffer: &Buffer, rope: &Rope) -> Option<Scope> {
    let (kind, name_node) = kind_and_name(node)?;
    let name = name_text(name_node, rope)?;
    Some(Scope {
        kind,
        name,
        start: position_of_byte(buffer, rope, node.start_byte()),
        end: position_of_byte(buffer, rope, node.end_byte()),
    })
}

/// What kind of scope a node is and the node that holds its name, or none for any other node.
fn kind_and_name(node: Node) -> Option<(&'static str, Node)> {
    let kind = match node.kind() {
        "function_declaration" | "generator_function_declaration" | "function_definition" | "function_item" => {
            "function"
        }
        "function_expression" | "function" | "generator_function" => "function",
        "method_definition" | "method_declaration" => "method",
        "class_declaration" | "abstract_class_declaration" | "class" => "class",
        "interface_declaration" => "interface",
        "enum_declaration" | "enum_item" => "enum",
        "struct_item" => "struct",
        "trait_item" => "trait",
        "mod_item" | "internal_module" | "module" => "module",
        "macro_definition" => "macro",
        "impl_item" => return impl_name(node).map(|name| ("impl", name)),
        "type_spec" => return go_type_name(node),
        "variable_declarator" | "public_field_definition" | "field_definition" | "pair" => {
            return function_bound_name(node).map(|name| ("function", name));
        }
        _ => return None,
    };
    node.child_by_field_name("name").map(|name| (kind, name))
}

/// The node an `impl` is named by: the type it implements for.
fn impl_name(node: Node) -> Option<Node> {
    node.child_by_field_name("type")
}

/// A Go `type` declaration that makes a struct or an interface, with its name.
fn go_type_name(node: Node) -> Option<(&'static str, Node)> {
    let name = node.child_by_field_name("name")?;
    match node.child_by_field_name("type")?.kind() {
        "struct_type" => Some(("struct", name)),
        "interface_type" => Some(("interface", name)),
        _ => None,
    }
}

/// The name of a variable, field or property whose value is a function. The function itself is
/// anonymous, so the name lives on what it is assigned to.
fn function_bound_name(node: Node) -> Option<Node> {
    let value = node.child_by_field_name("value")?;
    if !matches!(value.kind(), "arrow_function" | "function_expression" | "function" | "generator_function") {
        return None;
    }
    for field in ["name", "property", "key"] {
        if let Some(name) = node.child_by_field_name(field) {
            return Some(name);
        }
    }
    None
}

/// The text a scope shows for its name node. An `impl` of a trait reads `Trait for Type`.
fn name_text(name_node: Node, rope: &Rope) -> Option<String> {
    let mut text = node_text(name_node, rope);
    if let Some(parent) = name_node.parent() {
        if parent.kind() == "impl_item" {
            if let Some(trait_node) = parent.child_by_field_name("trait") {
                text = format!("{} for {}", node_text(trait_node, rope), text);
            }
        }
    }
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let first_line = text.lines().next().unwrap_or("");
    if first_line.chars().count() > MAX_NAME_CHARACTERS || first_line.len() != text.len() {
        let cut: String = first_line.chars().take(MAX_NAME_CHARACTERS).collect();
        return Some(format!("{cut}…"));
    }
    Some(first_line.to_string())
}

/// The text of a node.
fn node_text(node: Node, rope: &Rope) -> String {
    rope.byte_slice(node.byte_range()).to_string()
}

/// The position of a byte offset, in characters of its line.
fn position_of_byte(buffer: &Buffer, rope: &Rope, byte: usize) -> Position {
    buffer.position_of(rope.byte_to_char(byte.min(rope.len_bytes())))
}
