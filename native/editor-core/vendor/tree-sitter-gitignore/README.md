# tree-sitter-gitignore

The generated `parser.c`, `tree_sitter/parser.h`, `grammar.js` and `LICENSE` come unchanged from
<https://github.com/shunsambongi/tree-sitter-gitignore> at commit
`f4685bf11ac466dd278449bcfe5fd014e94aa504` (2022-05-04), MIT licensed. The grammar is not on crates.io and its
own Rust binding targets tree-sitter 0.20, so `build.rs` compiles the C source and
`src/syntax/gitignore.rs` loads it through `tree-sitter-language`. The parser is ABI 13, which tree-sitter
0.25 still reads.

`highlights.scm` is Grove's own: the grammar has no query.
