//! Grammars that arrive as WebAssembly: loading a `.wasm` file into a tree-sitter language, and
//! giving each parser the store the language needs to run in.
//!
//! A language is compiled once, in a store of its own that lives as long as the process. A parser
//! that parses with it gets a store of its own from the same engine, and tree-sitter instantiates
//! the compiled module there, so documents parse on their own threads without sharing one store.

use std::sync::{LazyLock, Mutex, MutexGuard};

use tree_sitter::wasmtime::Engine;
use tree_sitter::{Language, Parser, WasmStore};

/// The engine every store is made from. Languages only work in stores of the engine that compiled them.
static ENGINE: LazyLock<Engine> = LazyLock::new(Engine::default);

/// The store the languages are compiled in. Nothing parses with it; it keeps them alive.
static LOADER: LazyLock<Mutex<Option<WasmStore>>> = LazyLock::new(|| Mutex::new(WasmStore::new(&ENGINE).ok()));

/// Compiles a grammar's WebAssembly into a language. `symbol` is the name the module exports its
/// language under, the part after `tree_sitter_`.
pub fn load_language(symbol: &str, wasm: &[u8]) -> Result<Language, String> {
    let mut loader: MutexGuard<Option<WasmStore>> = LOADER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(store) = loader.as_mut() else {
        return Err("the WebAssembly engine could not start".to_string());
    };
    store.load_language(symbol, wasm).map_err(|error| error.to_string())
}

/// A parser that can run grammars of both kinds: the compiled-in ones, and those that are WebAssembly.
pub struct LayerParser {
    parser: Parser,
    /// Whether the parser has been given its store yet; it only needs one for the first WebAssembly language.
    has_store: bool,
}

impl LayerParser {
    /// A parser with no language yet.
    pub fn new() -> Self {
        LayerParser { parser: Parser::new(), has_store: false }
    }

    /// The underlying parser, set up to parse `language`: WebAssembly languages get a store first.
    pub fn prepared_for(&mut self, language: &Language) -> Result<&mut Parser, String> {
        if language.is_wasm() && !self.has_store {
            let store = WasmStore::new(&ENGINE).map_err(|error| error.to_string())?;
            self.parser.set_wasm_store(store).map_err(|error| error.to_string())?;
            self.has_store = true;
        }
        self.parser.set_language(language).map_err(|error| error.to_string())?;
        Ok(&mut self.parser)
    }
}
