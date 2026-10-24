//! Compiles the grammars that are vendored as C sources instead of coming from a crate.

use std::path::Path;

/// Builds the generated parser of the gitignore grammar, which has no crate.
fn main() {
    let directory = Path::new("vendor/tree-sitter-gitignore");
    let parser = directory.join("parser.c");
    cc::Build::new()
        .include(directory)
        .file(&parser)
        .flag_if_supported("-Wno-unused-parameter")
        .flag_if_supported("-Wno-unused-but-set-variable")
        .flag_if_supported("-Wno-trigraphs")
        .compile("tree-sitter-gitignore");
    println!("cargo:rerun-if-changed={}", parser.display());
}
