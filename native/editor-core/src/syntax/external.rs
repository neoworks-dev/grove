//! The grammars extensions bring, as WebAssembly. The app hands over the enabled ones whenever
//! the set changes, and each becomes a language that files are matched to after the compiled-in
//! ones, so a compiled-in language is never replaced.

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, RwLock};

use tree_sitter::Query;

use super::languages::{Grammar, LanguageDefinition, is_compiled_in};
use super::wasm::load_language;
use std::sync::OnceLock;

/// What an extension says about one grammar, with its files already read.
#[derive(Clone, Debug, Default, Hash)]
pub struct GrammarSpec {
    /// The language's name, such as `zig`.
    pub language: String,
    /// What the module exports its language as: the part after `tree_sitter_`.
    pub symbol: String,
    pub wasm: Vec<u8>,
    pub highlights: String,
    pub injections: Option<String>,
    pub locals: Option<String>,
    /// File extensions, without the dot.
    pub extensions: Vec<String>,
    /// Whole file names.
    pub file_names: Vec<String>,
}

/// A grammar that was left out, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RejectedGrammar {
    pub language: String,
    pub reason: String,
}

/// The grammars in use, and every definition built so far so that handing over the same grammar
/// again reuses it. A definition lives as long as the process, which is what lets documents hold a
/// plain reference to it; the cache keeps that from growing by one each time extensions reload.
struct Registry {
    active: Vec<&'static LanguageDefinition>,
    built: HashMap<u64, &'static LanguageDefinition>,
}

static REGISTRY: LazyLock<RwLock<Registry>> =
    LazyLock::new(|| RwLock::new(Registry { active: Vec::new(), built: HashMap::new() }));

/// Counts the times the set of grammars changed, so a document can tell its language may now be another.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// How many times the grammars handed over changed the set in use.
pub fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

/// The extension grammars in use, in the order they were given.
pub(super) fn languages() -> Vec<&'static LanguageDefinition> {
    REGISTRY.read().unwrap_or_else(|poisoned| poisoned.into_inner()).active.clone()
}

/// Replaces the grammars in use with these, and says which could not be used. A grammar whose
/// language is compiled in, or that an earlier one already named, is left out.
pub fn set_grammars(specs: Vec<GrammarSpec>) -> Vec<RejectedGrammar> {
    let mut registry = REGISTRY.write().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut active: Vec<&'static LanguageDefinition> = Vec::new();
    let mut rejected = Vec::new();
    for spec in specs {
        match build_or_reuse(&mut registry, &spec, &active) {
            Ok(definition) => active.push(definition),
            Err(reason) => rejected.push(RejectedGrammar { language: spec.language, reason }),
        }
    }
    let unchanged = active.len() == registry.active.len()
        && active.iter().zip(&registry.active).all(|(new, old)| std::ptr::eq(*new, *old));
    registry.active = active;
    if !unchanged {
        GENERATION.fetch_add(1, Ordering::Release);
    }
    rejected
}

/// The definition for a spec, built the first time it is seen, unless its language is taken.
fn build_or_reuse(
    registry: &mut Registry,
    spec: &GrammarSpec,
    taken: &[&'static LanguageDefinition],
) -> Result<&'static LanguageDefinition, String> {
    if is_compiled_in(&spec.language) {
        return Err(format!("{} is already a language Grove has built in", spec.language));
    }
    if taken.iter().any(|definition| definition.is_called(&spec.language)) {
        return Err(format!("another extension already brings {}", spec.language));
    }
    let mut hasher = DefaultHasher::new();
    spec.hash(&mut hasher);
    let key = hasher.finish();
    if let Some(definition) = registry.built.get(&key) {
        return Ok(definition);
    }
    let definition: &'static LanguageDefinition = Box::leak(Box::new(build_definition(spec)?));
    registry.built.insert(key, definition);
    Ok(definition)
}

/// Loads the grammar and compiles its queries, so a grammar that cannot work is refused at once.
fn build_definition(spec: &GrammarSpec) -> Result<LanguageDefinition, String> {
    let language = load_language(&spec.symbol, &spec.wasm)?;
    let locals = match &spec.locals {
        Some(source) => Some(Query::new(&language, source).map_err(|error| format!("locals do not compile: {error}"))?),
        None => None,
    };
    let definition = LanguageDefinition {
        name: leak(&spec.language),
        extensions: leak_all(&spec.extensions),
        file_names: leak_all(&spec.file_names),
        overlay: false,
        aliases: &[],
        grammar: Grammar::Wasm { language, highlights: spec.highlights.clone(), locals },
        injections: spec.injections.as_deref().map(leak),
        highlight_query: OnceLock::new(),
        injection_query: OnceLock::new(),
    };
    let highlights =
        definition.try_compile_highlights().map_err(|error| format!("highlights do not compile: {error}"))?;
    let injections =
        definition.try_compile_injections().map_err(|error| format!("injections do not compile: {error}"))?;
    let _ = definition.highlight_query.set(Some(highlights));
    let _ = definition.injection_query.set(injections);
    Ok(definition)
}

/// A string that lives as long as the process.
fn leak(text: &str) -> &'static str {
    Box::leak(text.to_string().into_boxed_str())
}

/// A list of strings that lives as long as the process.
fn leak_all(texts: &[String]) -> &'static [&'static str] {
    let leaked: Vec<&'static str> = texts.iter().map(|text| leak(text)).collect();
    Box::leak(leaked.into_boxed_slice())
}
