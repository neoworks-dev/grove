//! The languages Grove highlights: which file belongs to which grammar, and the queries each
//! grammar is read with. Most grammars are compiled into the app, and their own highlight
//! queries are used as they ship. Extensions add more as WebAssembly (see `external`); a
//! compiled-in language always wins over one of the same name.

use std::path::Path;
use std::sync::{LazyLock, OnceLock};

use tree_sitter::{Language, Query};

use super::external;
use super::highlight::{HighlightId, highlight_for_capture};

/// A highlight query together with the highlight each of its captures stands for, so reading
/// a capture's name happens once.
pub struct HighlightQuery {
    pub query: Query,
    /// For each capture index of the query, the highlight it paints, if it paints one.
    pub highlights: Vec<Option<HighlightId>>,
}

/// Where a language's grammar and highlight query come from.
pub(super) enum Grammar {
    /// Compiled into the app. A language that builds on another has that one's queries first.
    Compiled { grammar: fn() -> Language, highlights: fn() -> String },
    /// Loaded from a `.wasm` file an extension brought, with the query it came with.
    Wasm { language: Language, highlights: String, locals: Option<Query> },
}

/// One language: how its files are recognised, its grammar, and its queries.
pub struct LanguageDefinition {
    /// The name the language is known by, such as `rust`.
    pub name: &'static str,
    /// File extensions, without the dot.
    pub(super) extensions: &'static [&'static str],
    /// File names that have no extension to go by.
    pub(super) file_names: &'static [&'static str],
    /// Whether the language only adds to the colours of the text it is embedded in, instead of
    /// colouring all of it.
    pub overlay: bool,
    /// Other names a markdown code fence may call the language by.
    pub(super) aliases: &'static [&'static str],
    pub(super) grammar: Grammar,
    /// Finds code of other languages inside this one, such as a script in a Svelte file.
    pub(super) injections: Option<&'static str>,
    pub(super) highlight_query: OnceLock<Option<HighlightQuery>>,
    pub(super) injection_query: OnceLock<Option<Query>>,
}

impl LanguageDefinition {
    /// The tree-sitter grammar.
    pub fn grammar(&self) -> Language {
        match &self.grammar {
            Grammar::Compiled { grammar, .. } => grammar(),
            Grammar::Wasm { language, .. } => language.clone(),
        }
    }

    /// The query that finds the scopes, definitions and references of local names, if the grammar came with one.
    pub(super) fn locals_query(&self) -> Option<&Query> {
        match &self.grammar {
            Grammar::Compiled { .. } => None,
            Grammar::Wasm { locals, .. } => locals.as_ref(),
        }
    }

    /// The highlight query's source.
    fn highlight_source(&self) -> String {
        match &self.grammar {
            Grammar::Compiled { highlights, .. } => highlights(),
            Grammar::Wasm { highlights, .. } => highlights.clone(),
        }
    }

    /// The compiled highlight query, which is built the first time it is asked for. None, with
    /// the reason on stderr, when the grammar rejects its own query.
    pub fn highlight_query(&self) -> Option<&HighlightQuery> {
        self.highlight_query.get_or_init(|| self.compile_highlights()).as_ref()
    }

    /// The compiled query that finds embedded languages, if the language has one.
    pub fn injection_query(&self) -> Option<&Query> {
        self.injection_query.get_or_init(|| self.compile_injections()).as_ref()
    }

    /// Builds the highlight query from its source, or says why the grammar rejects it.
    pub(super) fn try_compile_highlights(&self) -> Result<HighlightQuery, String> {
        let source = self.highlight_source();
        let query = Query::new(&self.grammar(), &source).map_err(|error| error.to_string())?;
        let highlights = query.capture_names().iter().map(|name| highlight_for_capture(name)).collect();
        Ok(HighlightQuery { query, highlights })
    }

    /// Builds the highlight query, which is None, with the reason on stderr, when it does not compile.
    fn compile_highlights(&self) -> Option<HighlightQuery> {
        match self.try_compile_highlights() {
            Ok(compiled) => Some(compiled),
            Err(error) => {
                eprintln!("highlights for {} do not compile: {error}", self.name);
                None
            }
        }
    }

    /// Builds the injection query from its source, if there is one, or says why the grammar rejects it.
    pub(super) fn try_compile_injections(&self) -> Result<Option<Query>, String> {
        let Some(source) = self.injections else {
            return Ok(None);
        };
        Query::new(&self.grammar(), source).map(Some).map_err(|error| error.to_string())
    }

    /// Builds the injection query, which is None, with the reason on stderr, when it does not compile.
    fn compile_injections(&self) -> Option<Query> {
        match self.try_compile_injections() {
            Ok(compiled) => compiled,
            Err(error) => {
                eprintln!("injections for {} do not compile: {error}", self.name);
                None
            }
        }
    }

    /// Whether a name, such as a code fence's info string, refers to this language.
    pub(super) fn is_called(&self, name: &str) -> bool {
        self.name.eq_ignore_ascii_case(name) || self.aliases.iter().any(|alias| alias.eq_ignore_ascii_case(name))
    }
}

/// Embedded scripts and styles of a Svelte file. Where the script says `lang="ts"` both
/// patterns match and the later one, TypeScript, is kept.
const SVELTE_INJECTIONS: &str = r#"
((script_element (raw_text) @injection.content)
 (#set! injection.language "javascript"))

((script_element
  (start_tag
    (attribute
      (attribute_name) @_name
      (quoted_attribute_value (attribute_value) @_value)))
  (raw_text) @injection.content)
 (#eq? @_name "lang")
 (#any-of? @_value "ts" "typescript")
 (#set! injection.language "typescript"))

((style_element (raw_text) @injection.content)
 (#set! injection.language "css"))
"#;

/// What markdown embeds: the inline syntax of its paragraphs, code fences in the language
/// they name, and raw HTML.
const MARKDOWN_INJECTIONS: &str = r#"
((inline) @injection.content
 (#set! injection.language "markdown_inline"))

(fenced_code_block
  (info_string (language) @injection.language)
  (code_fence_content) @injection.content)

((html_block) @injection.content
 (#set! injection.language "html"))
"#;

/// The TypeScript queries build on JavaScript's, as the grammar is JavaScript's with types added.
fn typescript_highlights() -> String {
    format!("{}\n{}", tree_sitter_javascript::HIGHLIGHT_QUERY, tree_sitter_typescript::HIGHLIGHTS_QUERY)
}

/// TSX is TypeScript with JSX.
fn tsx_highlights() -> String {
    format!("{}\n{}", typescript_highlights(), tree_sitter_javascript::JSX_HIGHLIGHT_QUERY)
}

/// JavaScript with JSX, which its grammar parses.
fn javascript_highlights() -> String {
    format!("{}\n{}", tree_sitter_javascript::HIGHLIGHT_QUERY, tree_sitter_javascript::JSX_HIGHLIGHT_QUERY)
}

/// What the C and C++ queries leave out: `true` and `false`.
const C_FAMILY_EXTRAS: &str = "[(true) (false)] @boolean";

/// C++ namespaces, which its query leaves uncoloured.
const CPP_EXTRAS: &str = "(namespace_identifier) @module";

/// The numbers of SQL. The grammar's own query tells them apart from strings with Lua patterns,
/// which the regex engine here does not read, so every literal would be coloured as a string.
const SQL_EXTRAS: &str = r#"((literal) @number (#match? @number "^[-+]?[0-9]+([.][0-9]*)?$"))"#;

/// The C queries, with `true` and `false` added.
fn c_highlights() -> String {
    format!("{}\n{}", tree_sitter_c::HIGHLIGHT_QUERY, C_FAMILY_EXTRAS)
}

/// C++ is C with more, and its own query only adds to C's.
fn cpp_highlights() -> String {
    format!(
        "{}\n{}\n{}\n{}",
        tree_sitter_c::HIGHLIGHT_QUERY,
        tree_sitter_cpp::HIGHLIGHT_QUERY,
        C_FAMILY_EXTRAS,
        CPP_EXTRAS
    )
}

/// The CMake queries, with the two Lua patterns they use written as regular expressions, which are
/// what the query engine understands: all-capital arguments are constants, and `#!` starts a
/// comment that is a directive.
fn cmake_highlights() -> String {
    tree_sitter_cmake::HIGHLIGHTS_QUERY
        .replace(r#"#lua-match? @constant "^[%u@][%u%d_]+$""#, r#"#match? @constant "^[A-Z@][A-Z0-9_]+$""#)
        .replace(r#"#lua-match? @keyword.directive "^#!/""#, r#"#match? @keyword.directive "^#!/""#)
}

/// SCSS is CSS with more, and its own query only adds to CSS's.
fn scss_highlights() -> String {
    format!("{}\n{}", tree_sitter_css::HIGHLIGHTS_QUERY, tree_sitter_scss::HIGHLIGHTS_QUERY)
}

/// The SQL queries, with numbers told apart from strings.
fn sql_highlights() -> String {
    format!("{}\n{}", tree_sitter_sequel::HIGHLIGHTS_QUERY, SQL_EXTRAS)
}

/// Svelte is HTML with blocks and expressions, so its queries come after HTML's.
fn svelte_highlights() -> String {
    format!("{}\n{}", tree_sitter_html::HIGHLIGHTS_QUERY, tree_sitter_svelte_ng::HIGHLIGHTS_QUERY)
}

/// Starts a definition; the optional parts are filled in by the caller.
fn definition(
    name: &'static str,
    extensions: &'static [&'static str],
    grammar: fn() -> Language,
    highlights: fn() -> String,
) -> LanguageDefinition {
    LanguageDefinition {
        name,
        extensions,
        file_names: &[],
        overlay: false,
        aliases: &[],
        grammar: Grammar::Compiled { grammar, highlights },
        injections: None,
        highlight_query: OnceLock::new(),
        injection_query: OnceLock::new(),
    }
}

static LANGUAGES: LazyLock<Vec<LanguageDefinition>> = LazyLock::new(build_languages);

/// Every language, in the order files are matched.
fn build_languages() -> Vec<LanguageDefinition> {
    let mut javascript = definition(
        "javascript",
        &["js", "mjs", "cjs", "jsx"],
        || tree_sitter_javascript::LANGUAGE.into(),
        javascript_highlights,
    );
    javascript.aliases = &["js", "jsx"];

    let mut typescript = definition(
        "typescript",
        &["ts", "mts", "cts"],
        || tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        typescript_highlights,
    );
    typescript.aliases = &["ts"];

    let tsx = definition("tsx", &["tsx"], || tree_sitter_typescript::LANGUAGE_TSX.into(), tsx_highlights);

    let mut rust = definition(
        "rust",
        &["rs"],
        || tree_sitter_rust::LANGUAGE.into(),
        || tree_sitter_rust::HIGHLIGHTS_QUERY.to_string(),
    );
    rust.aliases = &["rs"];

    let json = definition(
        "json",
        &["json", "jsonc", "json5"],
        || tree_sitter_json::LANGUAGE.into(),
        || tree_sitter_json::HIGHLIGHTS_QUERY.to_string(),
    );

    let mut markdown = definition(
        "markdown",
        &["md", "markdown"],
        || tree_sitter_md::LANGUAGE.into(),
        || tree_sitter_md::HIGHLIGHT_QUERY_BLOCK.to_string(),
    );
    markdown.aliases = &["md"];
    markdown.injections = Some(MARKDOWN_INJECTIONS);

    let mut markdown_inline = definition(
        "markdown_inline",
        &[],
        || tree_sitter_md::INLINE_LANGUAGE.into(),
        || tree_sitter_md::HIGHLIGHT_QUERY_INLINE.to_string(),
    );

    markdown_inline.overlay = true;

    let css = definition(
        "css",
        &["css"],
        || tree_sitter_css::LANGUAGE.into(),
        || tree_sitter_css::HIGHLIGHTS_QUERY.to_string(),
    );

    let mut html = definition(
        "html",
        &["html", "htm"],
        || tree_sitter_html::LANGUAGE.into(),
        || tree_sitter_html::HIGHLIGHTS_QUERY.to_string(),
    );
    html.injections = Some(tree_sitter_html::INJECTIONS_QUERY);

    let go =
        definition("go", &["go"], || tree_sitter_go::LANGUAGE.into(), || tree_sitter_go::HIGHLIGHTS_QUERY.to_string());

    let lua = definition(
        "lua",
        &["lua"],
        || tree_sitter_lua::LANGUAGE.into(),
        || tree_sitter_lua::HIGHLIGHTS_QUERY.to_string(),
    );

    let mut bash = definition(
        "bash",
        &["sh", "bash", "zsh"],
        || tree_sitter_bash::LANGUAGE.into(),
        || tree_sitter_bash::HIGHLIGHT_QUERY.to_string(),
    );
    bash.file_names = &[
        ".bashrc",
        ".bash_profile",
        ".bash_login",
        ".bash_logout",
        ".bash_aliases",
        ".zshrc",
        ".zshenv",
        ".zprofile",
        ".profile",
    ];
    bash.aliases = &["sh", "shell", "zsh", "dash", "ksh", "ash"];

    let mut svelte = definition("svelte", &["svelte"], || tree_sitter_svelte_ng::LANGUAGE.into(), svelte_highlights);
    svelte.injections = Some(SVELTE_INJECTIONS);

    let mut toml = definition(
        "toml",
        &["toml"],
        || tree_sitter_toml_ng::LANGUAGE.into(),
        || tree_sitter_toml_ng::HIGHLIGHTS_QUERY.to_string(),
    );
    toml.file_names = &["Cargo.lock", "Pipfile", "poetry.lock"];

    let mut yaml = definition(
        "yaml",
        &["yaml", "yml"],
        || tree_sitter_yaml::LANGUAGE.into(),
        || tree_sitter_yaml::HIGHLIGHTS_QUERY.to_string(),
    );
    yaml.aliases = &["yml"];

    let mut python = definition(
        "python",
        &["py", "pyi"],
        || tree_sitter_python::LANGUAGE.into(),
        || tree_sitter_python::HIGHLIGHTS_QUERY.to_string(),
    );
    python.aliases = &["py"];

    let c = definition("c", &["c", "h"], || tree_sitter_c::LANGUAGE.into(), c_highlights);

    let mut cpp =
        definition("cpp", &["cpp", "cc", "cxx", "hpp", "hh"], || tree_sitter_cpp::LANGUAGE.into(), cpp_highlights);
    cpp.aliases = &["c++", "cc", "cxx", "hpp"];

    let mut dockerfile = definition(
        "dockerfile",
        &["dockerfile"],
        || tree_sitter_containerfile::LANGUAGE.into(),
        || tree_sitter_containerfile::HIGHLIGHTS_QUERY.to_string(),
    );
    dockerfile.file_names = &["Dockerfile", "Containerfile"];
    dockerfile.aliases = &["docker", "containerfile"];
    dockerfile.injections = Some(tree_sitter_containerfile::INJECTIONS_QUERY);

    let sql = definition("sql", &["sql"], || tree_sitter_sequel::LANGUAGE.into(), sql_highlights);

    let mut surrealql = definition("surrealql", &["surql", "surrealql"], tree_sitter_surrealql::language, || {
        tree_sitter_surrealql::HIGHLIGHTS_QUERY.to_string()
    });
    surrealql.aliases = &["surql"];

    let mut make = definition(
        "make",
        &["mk"],
        || tree_sitter_make::LANGUAGE.into(),
        || tree_sitter_make::HIGHLIGHTS_QUERY.to_string(),
    );
    make.file_names = &["Makefile", "makefile", "GNUmakefile"];
    make.aliases = &["makefile"];

    let mut cmake = definition("cmake", &["cmake"], || tree_sitter_cmake::LANGUAGE.into(), cmake_highlights);
    cmake.file_names = &["CMakeLists.txt"];

    let scss = definition("scss", &["scss"], tree_sitter_scss::language, scss_highlights);

    let xml = definition(
        "xml",
        &["xml", "svg", "plist", "xsd"],
        || tree_sitter_xml::LANGUAGE_XML.into(),
        || tree_sitter_xml::XML_HIGHLIGHT_QUERY.to_string(),
    );

    let mut gitignore = definition(
        "gitignore",
        &[],
        || super::gitignore::LANGUAGE.into(),
        || super::gitignore::HIGHLIGHTS_QUERY.to_string(),
    );
    gitignore.file_names = &[".gitignore", ".dockerignore", ".ignore", ".prettierignore", ".npmignore"];
    gitignore.aliases = &["ignore"];

    let fish =
        definition("fish", &["fish"], tree_sitter_fish::language, || tree_sitter_fish::HIGHLIGHTS_QUERY.to_string());

    vec![
        javascript,
        typescript,
        tsx,
        rust,
        json,
        markdown,
        markdown_inline,
        css,
        html,
        go,
        lua,
        bash,
        svelte,
        toml,
        yaml,
        python,
        c,
        cpp,
        dockerfile,
        sql,
        surrealql,
        make,
        cmake,
        scss,
        xml,
        gitignore,
        fish,
    ]
}

/// The language a file is written in, going by its extension or its name.
pub fn language_for_path(path: &Path) -> Option<&'static LanguageDefinition> {
    let file_name = path.file_name()?.to_str()?;
    let extension = path.extension().and_then(|extension| extension.to_str());
    let matches = |language: &&'static LanguageDefinition| {
        let by_name = language.file_names.contains(&file_name);
        let by_extension = extension.is_some_and(|extension| language.extensions.contains(&extension));
        by_name || by_extension
    };
    if let Some(language) = LANGUAGES.iter().find(|language| matches(language)) {
        return Some(language);
    }
    external::languages().into_iter().find(matches)
}

/// The language a script says it is written in on its first line, such as `#!/usr/bin/env bash`.
pub fn language_for_shebang(first_line: &str) -> Option<&'static LanguageDefinition> {
    let command = first_line.strip_prefix("#!")?;
    let mut words = command.split_whitespace();
    let program = words.next()?;
    let mut interpreter = program.rsplit('/').next()?;
    if interpreter == "env" {
        interpreter = words.find(|word| !word.starts_with('-'))?;
    }
    // `python3.12` is python, `bash5` is bash.
    let name = interpreter.trim_end_matches(|character: char| character.is_ascii_digit() || character == '.');
    language_for_name(name)
}

/// The language a name refers to, such as the one after the backticks of a code fence.
pub fn language_for_name(name: &str) -> Option<&'static LanguageDefinition> {
    if let Some(language) = LANGUAGES.iter().find(|language| language.is_called(name)) {
        return Some(language);
    }
    external::languages().into_iter().find(|language| language.is_called(name))
}

/// Whether a compiled-in language has this name, which an extension's grammar cannot take over.
pub(super) fn is_compiled_in(name: &str) -> bool {
    LANGUAGES.iter().any(|language| language.is_called(name))
}

/// Every compiled-in language, so tests and tools can go through them all.
pub fn all_languages() -> &'static [LanguageDefinition] {
    &LANGUAGES
}
