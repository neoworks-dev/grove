//! The named scopes around a cursor, per language: what breadcrumbs show.

use std::path::Path;

use editor_core::{Buffer, EditorState, Position};

/// The scopes at the place marked `|` in the text, as `kind name` pairs, outermost first.
fn scopes_at_marker(file_name: &str, marked_text: &str) -> Vec<String> {
    let marker = marked_text.find('|').expect("the text needs a | marking the cursor");
    let text = marked_text.replacen('|', "", 1);
    let state = EditorState::new(Buffer::from_text_named(&text, Path::new(file_name)));
    let before = &text[..marker];
    let row = before.matches('\n').count();
    let column = before.rsplit('\n').next().unwrap_or("").chars().count();
    state.scopes_at(Position { row, column }).iter().map(|scope| format!("{} {}", scope.kind, scope.name)).collect()
}

#[test]
fn typescript_classes_methods_and_functions_nest() {
    let text = "
export class Server {
  start(port: number) {
    function listen() {
      return |port
    }
  }
}
";
    assert_eq!(scopes_at_marker("a.ts", text), ["class Server", "method start", "function listen"]);
}

#[test]
fn typescript_functions_held_by_variables_and_fields_take_their_name() {
    let arrow = "const handler = (event: Event) => {\n  |event.stop()\n}\n";
    assert_eq!(scopes_at_marker("a.ts", arrow), ["function handler"]);
    let field = "class View {\n  onPress = () => {\n    |this.x\n  }\n}\n";
    assert_eq!(scopes_at_marker("a.ts", field), ["class View", "function onPress"]);
    let property = "const table = {\n  run: function () {\n    |go()\n  },\n}\n";
    assert_eq!(scopes_at_marker("a.js", property), ["function run"]);
}

#[test]
fn typescript_interfaces_enums_and_namespaces_are_scopes() {
    let interface = "interface Options {\n  name: |string\n}\n";
    assert_eq!(scopes_at_marker("a.ts", interface), ["interface Options"]);
    let namespace = "namespace Outer {\n  enum Mode {\n    On = |1,\n  }\n}\n";
    assert_eq!(scopes_at_marker("a.ts", namespace), ["module Outer", "enum Mode"]);
}

#[test]
fn outside_every_scope_there_is_none() {
    let text = "const a = 1\n|\nfunction later() {}\n";
    assert_eq!(scopes_at_marker("a.ts", text), Vec::<String>::new());
}

#[test]
fn rust_modules_impls_traits_and_functions_nest() {
    let text = "
mod engine {
    pub struct Motor;

    impl Motor {
        pub fn run(&self) {
            fn inner() {
                |let x = 1;
            }
        }
    }
}
";
    assert_eq!(scopes_at_marker("a.rs", text), ["module engine", "impl Motor", "function run", "function inner"]);
}

#[test]
fn a_rust_trait_impl_reads_trait_for_type() {
    let text = "impl Display for Motor {\n    fn fmt(&self) {\n        |write()\n    }\n}\n";
    assert_eq!(scopes_at_marker("a.rs", text), ["impl Display for Motor", "function fmt"]);
}

#[test]
fn rust_structs_enums_and_traits_are_scopes_but_expressions_are_not() {
    assert_eq!(scopes_at_marker("a.rs", "struct Point {\n    x: |i32,\n}\n"), ["struct Point"]);
    assert_eq!(scopes_at_marker("a.rs", "enum Shape {\n    Circle(|f64),\n}\n"), ["enum Shape"]);
    assert_eq!(scopes_at_marker("a.rs", "trait Draw {\n    fn draw(&self) { |paint() }\n}\n"), ["trait Draw", "function draw"]);
    let construction = "fn make() -> Point {\n    Point { x: |1 }\n}\n";
    assert_eq!(scopes_at_marker("a.rs", construction), ["function make"]);
}

#[test]
fn go_functions_methods_and_struct_types() {
    let function = "package main\n\nfunc serve(port int) {\n\t|listen()\n}\n";
    assert_eq!(scopes_at_marker("a.go", function), ["function serve"]);
    let method = "package main\n\nfunc (s *Server) Start() {\n\t|s.run()\n}\n";
    assert_eq!(scopes_at_marker("a.go", method), ["method Start"]);
    let structure = "package main\n\ntype Server struct {\n\tport |int\n}\n";
    assert_eq!(scopes_at_marker("a.go", structure), ["struct Server"]);
    let interface = "package main\n\ntype Runner interface {\n\tRun|()\n}\n";
    assert_eq!(scopes_at_marker("a.go", interface), ["interface Runner"]);
    let alias = "package main\n\ntype Count |int\n";
    assert_eq!(scopes_at_marker("a.go", alias), Vec::<String>::new());
}

#[test]
fn a_svelte_script_continues_the_chain_inside_the_file() {
    let text = "
<script lang=\"ts\">
  function save() {
    const go = () => {
      |submit()
    }
  }
</script>

<button>save</button>
";
    assert_eq!(scopes_at_marker("A.svelte", text), ["function save", "function go"]);
    let markup = "<script lang=\"ts\">\n  function save() {}\n</script>\n\n<button>|save</button>\n";
    assert_eq!(scopes_at_marker("A.svelte", markup), Vec::<String>::new());
}

#[test]
fn lua_and_bash_functions_are_scopes() {
    assert_eq!(scopes_at_marker("a.lua", "local function setup()\n  |run()\nend\n"), ["function setup"]);
    assert_eq!(scopes_at_marker("a.sh", "deploy() {\n  |echo hi\n}\n"), ["function deploy"]);
}

#[test]
fn scopes_follow_edits() {
    let mut state = EditorState::new(Buffer::from_text_named("fn a() {\n    1\n}\n", Path::new("a.rs")));
    let inside = Position { row: 1, column: 4 };
    assert_eq!(state.scopes_at(inside).len(), 1);
    state.apply(&editor_core::Command::PlaceCursor { at: Position { row: 0, column: 4 } });
    state.apply(&editor_core::Command::InsertText { text: "bc".to_string() });
    let scopes = state.scopes_at(inside);
    assert_eq!(scopes[0].name, "abc");
}

#[test]
fn a_scope_knows_where_it_starts_and_ends() {
    let state = EditorState::new(Buffer::from_text_named("struct A;\n\nfn b() {\n    1\n}\n", Path::new("a.rs")));
    let scopes = state.scopes_at(Position { row: 3, column: 4 });
    assert_eq!(scopes[0].start, Position { row: 2, column: 0 });
    assert_eq!(scopes[0].end, Position { row: 4, column: 1 });
}
