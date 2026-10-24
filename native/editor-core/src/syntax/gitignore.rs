//! The gitignore grammar, which is not on crates.io. Its generated parser is vendored under
//! `vendor/tree-sitter-gitignore` and compiled by `build.rs`.

use tree_sitter_language::LanguageFn;

unsafe extern "C" {
    fn tree_sitter_gitignore() -> *const ();
}

/// The tree-sitter grammar of ignore files such as `.gitignore`.
pub const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_gitignore) };

/// The highlight query Grove writes for it, as the grammar has none.
pub const HIGHLIGHTS_QUERY: &str = include_str!("../../vendor/tree-sitter-gitignore/highlights.scm");
