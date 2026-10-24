# Extensions

An extension is an npm package that adds parts to native Grove: plugins, tree-sitter grammars,
language servers, themes and settings. One package can carry any mix of them. Extensions are
installed into Grove's data directory, and the kernel loads them at start-up.

## The manifest

The manifest is the `grove` field of the package's `package.json`. It is the one place a package
says what it contributes, so there is no second file to keep in step with the first. A package
that wants to be found on npm also lists `grove-extension` in its `keywords`.

```json
{
  "name": "grove-hello",
  "version": "0.1.0",
  "description": "A greeting in the status bar.",
  "keywords": ["grove-extension"],
  "grove": {
    "title": "Hello",
    "plugins": [{ "id": "hello", "title": "Greeting", "source": "src/hello.ts", "main": "dist/hello.js" }],
    "grammars": [],
    "languageServers": [],
    "tools": [],
    "themes": [],
    "settings": {}
  }
}
```

Every list may be left out. A part that is wrong is dropped and reported, and the rest of the
extension still loads. All paths are relative to the package and may not leave it.

### `plugins`

Each entry is a plugin script. `id` names it inside the package, and its profile row is
`<package>:<id>`, which is what a user's profile uses to configure or disable it. `main` is the
script Grove runs. `source` is what `scripts/buildExtension.mjs` builds `main` from, and Grove
does not read it.

A plugin script calls `definePlugin` from `@grove/extension` with the object form of a plugin
(`inject`, `Config`, `apply`), as the core plugins are written. Its `Config`, made with
`defineSettings`, becomes its section of the settings page.

### `grammars`

A tree-sitter grammar built to WebAssembly, with its queries.

```json
{ "language": "zig", "wasm": "grammars/zig.wasm", "highlights": "queries/highlights.scm",
  "locals": "queries/locals.scm", "extensions": ["zig"], "fileNames": ["build.zig.zon"] }
```

`extensions` (without the dot) and `fileNames` say which files the grammar highlights, and at
least one is needed. `symbol` is the name the grammar exports its language under when it is not
the language name, the part after `tree_sitter_`. Build the module with `tree-sitter build --wasm`.

Grove hands the enabled grammars to the editor whenever the set of extensions changes, so a grammar
takes effect at once, in files that are already open too. Each one is compiled when it is handed
over, and one that cannot be used is left out with the reason in the log, while the rest still work.

A language that Grove has built in always wins. A grammar for `toml`, or one that claims the
`rs` extension, is left out, so an extension adds languages and never changes the ones Grove ships.
Two extensions that bring the same language leave the second one out.

The queries are the ones tree-sitter grammars ship, with two differences. Grove reads patterns
written for the `#match?` predicate as regular expressions, so a query that uses `#lua-match?` has to
be rewritten (the `grove-zig` sample shows how). Capture names are sorted into the highlights of
Grove's theme by their longest known prefix, so `@keyword.return` is a keyword and `@variable.member` is a property.

- `highlights` colours the text.
- `injections` finds code of other languages inside it, which must be languages Grove has or another extension brings.
- `locals` marks `@local.scope`, `@local.definition` and `@local.reference` captures. A use of a name that resolves
  to a definition in an enclosing scope is coloured as the definition is, so a parameter looks like one where it is used.

### `languageServers`

```json
{ "id": "taplo", "name": "Taplo", "command": "taplo", "args": ["lsp", "stdio"], "languageId": "toml",
  "extensions": ["toml"], "rootMarkers": [".git"],
  "install": { "kind": "github-release", "repo": "tamasfe/taplo",
               "assets": { "linux-x64": "taplo-linux-x86_64.gz" }, "archive": "gz", "binaries": ["taplo"] } }
```

`install` is optional and is an install recipe, below. `tools` entries are the same recipes for
tools that are not language servers, with an `id`, a `name` and an `install`.

### `themes`

`{ "id": "night", "name": "Night", "scheme": "dark", "file": "themes/night.json" }`, or `tokens`
inline in place of `file`. The tokens are the colour names of Grove's own themes. A token left
out comes from Grove's own theme of the same scheme. The theme's id is `<package>:<id>`.

### `settings`

Settings the extension declares without a plugin, as the same fields a plugin's `defineSettings`
takes, written as JSON.

```json
{ "level": { "type": "number", "label": "Level", "default": 3, "min": 1, "max": 9 } }
```

They get a row of their own, `<package>:settings`, on the settings page.

### Install recipes

A recipe says how a tool gets onto the machine without root. Grove installs it into its own
tools directory and puts the directory first on the language server lookup path.

| `kind` | Fields |
|---|---|
| `github-release` | `repo`, `tag` (the latest when left out), `assets` (an asset name for each of `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`, `windows-x64`, `windows-arm64`), `archive` (`auto`, which reads the asset name and is the default, `none`, `gz`, `tar.gz` or `zip`), `binaries` |
| `npm` | `package`, `version`, `binaries` |
| `pip` | `package`, `version`, `binaries` |
| `cargo` | `crate`, `version`, `binaries` |
| `go` | `package`, `version`, `binaries` (built with `go install`, which needs the Go toolchain) |

## Where extensions live

Grove's data directory is the one the sidecar uses: `GROVE_SIDECAR_DATA` when it is set, else
`grove-native` under `XDG_DATA_HOME`, else `~/.local/share/grove-native`. Setting the variable
moves everything at once, which is how tests keep installs out of a real profile.

```text
<data>/extensions/<package>/package.json    one directory for each extension
<data>/extensions/@scope+name/...           a scoped package, with the slash as a plus
<data>/extensions/state.json                {"disabled": ["package", ...]}
```

An extension on the disabled list contributes nothing. Its manifest is still read, so lists can
show it.

## How it loads

At start-up, and again whenever extensions change, the `extensions` service reads every
directory, parses each manifest, runs the scripts of the enabled extensions and puts their
plugins in the plugin catalog as `<package>:<id>`. The profile gets one row for each, in a layer
between the core rows and the user's file. So an extension plugin is an ordinary profile row:

- the user's profile configures or disables it by that row id,
- the settings page lists it with the settings its `Config` declares,
- a script that throws, or is missing, shows as a failed row with the reason, and nothing else
  is affected.

Scripts run inside the app, with the same access as a core plugin. They get the app's own copy
of these modules from `require`, and nothing else: `svelte`, `svelte/internal/client`,
`@neoworks/svelte-gpui`, `@neoworks/svelte-gpui/ui`, `@neoworks/extension-system` and
`@grove/extension`. The last one has `definePlugin`, `defineSettings`, `setting`, and the design
tokens `colors`, `space`, `radius`, `fontSize` and `size`.

## Building an extension

```text
bun scripts/buildExtension.mjs samples/extensions/grove-hello
```

builds every plugin that names a `source` into its `main`, leaving the shared modules external.
`samples/extensions/grove-hello` is a complete extension. To try it, build it and copy the
directory (with `dist/` and `package.json`) into `<data>/extensions/`.

## The extensions view

The extensions view is on the rail (Ctrl+Shift+X). It lists the installed extensions, with buttons
to switch each one off or on, to update it when npm has a newer version, and to remove it, and it
searches npm for packages with the `grove-extension` keyword. Installing from a search result
loads the plugins at once, with no restart. A change to an extension leaves its settings alone.

The search and the download go through svelte-gpui's `fetch`, and the `registry` setting of the
`extensions-view` row says which registry that is (npm's own by default). No `npm` binary is
involved. The host checks the tarball against the hash the registry published before it unpacks
it, refuses a package that is not the one asked for or has no `grove` field, and replaces the old
install only when the new one has passed (`src/extensions.rs`).

To try an extension without publishing it, `scripts/mockRegistry.mjs` packs directories with
`npm pack` and serves them from the endpoints Grove uses:

```text
bun scripts/mockRegistry.mjs 4873 samples/extensions/grove-hello samples/extensions/grove-night-theme
```

then give the `extensions-view` row `{"registry": "http://127.0.0.1:4873"}` in the user profile.

## Configuring an extension

An installed extension's row in the extensions view has a Settings button when any of its
plugins declares settings, or its manifest does. It opens a form under the row with one block for
each plugin, built from the plugin's `Config` with the same field rows the settings page uses, and
one for the settings the manifest declares. A change is written to the user's profile as an
override on that plugin's row (`<package>:<id>`), exactly as on the settings page, so the page and
the view always agree. A field marked `live` reaches the plugin while it runs, and any other field
mounts the plugin again. Reset takes an override back out. A plugin that failed to load still
lists its settings, with the reason it failed, so a bad value can be put right.
