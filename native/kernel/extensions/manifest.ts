// The extension manifest: the `grove` field of an extension's `package.json`. One package can
// contribute several kinds of part, and the parser keeps what is valid and reports the rest,
// so a typo in one grammar never stops the plugins next to it from loading. Pure functions, so
// the format is testable without a host. `docs/extensions.md` describes the format for authors.

import { describeFieldProblem, type SettingField } from "../settings/schema";
import { parseRecipe, type InstallRecipe } from "./recipes";
import {
  isPlainObject,
  readEach,
  readOptionalPackagePath,
  readOptionalString,
  readPackagePath,
  readString,
  readStringList,
} from "./reading";

/** The keyword that marks an npm package as a Grove extension. */
export const EXTENSION_KEYWORD = "grove-extension";

/** A plugin the extension adds to the kernel. */
export interface PluginContribution {
  /** Names the plugin inside the extension; its profile row is `<package>:<id>`. */
  id: string;
  /** The script to run, relative to the package. It calls `definePlugin` from `@grove/extension`. */
  main: string;
  /** The source `scripts/buildExtension.mjs` builds `main` from. Grove does not read it. */
  source?: string;
  /** What lists show instead of the id. */
  title?: string;
  description?: string;
}

/** A tree-sitter grammar, built to WebAssembly, with its queries. */
export interface GrammarContribution {
  /** The language's name, such as `toml`. */
  language: string;
  /** The grammar as a `.wasm` file, relative to the package. */
  wasm: string;
  /** The name the grammar exports its language under (`tree_sitter_<symbol>`); the language name when left out. */
  symbol?: string;
  highlights?: string;
  injections?: string;
  locals?: string;
  /** File extensions, without the dot, the grammar highlights. */
  extensions: string[];
  /** Whole file names, such as `Cargo.lock`, the grammar highlights. */
  fileNames: string[];
}

/** A language server and, if Grove can install it, how. */
export interface LanguageServerContribution {
  id: string;
  /** What the status bar calls it. */
  name: string;
  /** The executable to run, found in Grove's tools directory first and then on the usual search path. */
  command: string;
  args: string[];
  /** The language id sent to the server when a file opens. */
  languageId: string;
  extensions: string[];
  fileNames: string[];
  /** Files or directories that mark the root of a workspace. */
  rootMarkers: string[];
  install?: InstallRecipe;
}

/** A tool that is not a language server, such as a formatter, that Grove can install for the extension. */
export interface ToolContribution {
  id: string;
  name: string;
  install: InstallRecipe;
}

/** A colour theme, held in a JSON file of tokens, or inline. Tokens it leaves out come from Grove's own theme of the same scheme. */
export interface ThemeContribution {
  id: string;
  name: string;
  scheme: "dark" | "light";
  /** A JSON file with a `tokens` object (or the tokens themselves), relative to the package. */
  file?: string;
  tokens?: Record<string, string>;
}

/** What an extension contributes. */
export interface ExtensionManifest {
  /** The package's name. */
  name: string;
  version: string;
  title: string;
  description: string;
  plugins: PluginContribution[];
  grammars: GrammarContribution[];
  languageServers: LanguageServerContribution[];
  tools: ToolContribution[];
  themes: ThemeContribution[];
  /** Settings the extension declares without a plugin to read them. */
  settings: Record<string, SettingField>;
}

export interface ParsedManifest {
  /** Null when the package is not an extension at all or has no usable name. */
  manifest: ExtensionManifest | null;
  /** Everything that was wrong, for the log and for the extensions view. */
  problems: string[];
}

/** Reads the `package.json` of an installed extension. */
export function parseManifest(text: string, source: string): ParsedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { manifest: null, problems: [`${source}: not valid JSON (${describeError(error)})`] };
  }
  if (!isPlainObject(parsed)) {
    return { manifest: null, problems: [`${source}: expected a JSON object`] };
  }
  const problems: string[] = [];
  const name = readString(parsed, "name", source, problems);
  const grove = parsed.grove;
  if (name === undefined || !isPlainObject(grove)) {
    if (name !== undefined) {
      problems.push(`${source}: no "grove" field, so this package contributes nothing`);
    }
    return { manifest: null, problems };
  }
  const manifest = readContributions(parsed, grove, name, source, problems);
  return { manifest, problems };
}

/** The manifest of a package whose `grove` field is known to be an object. */
function readContributions(
  packageJson: Record<string, unknown>,
  grove: Record<string, unknown>,
  name: string,
  source: string,
  problems: string[],
): ExtensionManifest {
  const where = `${name}`;
  return {
    name,
    version: textOr(packageJson.version, "0.0.0"),
    title: textOr(grove.title, name),
    description: textOr(packageJson.description, ""),
    plugins: readEach(grove, "plugins", where, problems, readPlugin(problems)),
    grammars: readEach(grove, "grammars", where, problems, readGrammar(problems)),
    languageServers: readEach(grove, "languageServers", where, problems, readLanguageServer(problems)),
    tools: readEach(grove, "tools", where, problems, readTool(problems)),
    themes: readEach(grove, "themes", where, problems, readTheme(problems)),
    settings: readSettings(grove.settings, where, problems),
  };
}

/** A string value, or the fallback when it is not text. */
function textOr(value: unknown, fallback: string): string {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  return fallback;
}

/** The reader of one `plugins` entry. */
function readPlugin(problems: string[]): (entry: unknown, where: string) => PluginContribution | null {
  return (entry, where) => {
    if (!isPlainObject(entry)) {
      problems.push(`${where}: must be an object`);
      return null;
    }
    const id = readIdentifier(entry, where, problems);
    const main = readPackagePath(entry, "main", where, problems);
    if (id === undefined || main === undefined) {
      return null;
    }
    return {
      id,
      main,
      source: readOptionalPackagePath(entry, "source", where, problems),
      title: readOptionalString(entry, "title", where, problems),
      description: readOptionalString(entry, "description", where, problems),
    };
  };
}

/** The reader of one `grammars` entry. */
function readGrammar(problems: string[]): (entry: unknown, where: string) => GrammarContribution | null {
  return (entry, where) => {
    if (!isPlainObject(entry)) {
      problems.push(`${where}: must be an object`);
      return null;
    }
    const language = readString(entry, "language", where, problems);
    const wasm = readPackagePath(entry, "wasm", where, problems);
    const extensions = readStringList(entry, "extensions", where, problems, true);
    const fileNames = readStringList(entry, "fileNames", where, problems, true);
    if (language === undefined || wasm === undefined) {
      return null;
    }
    if (extensions.length === 0 && fileNames.length === 0) {
      problems.push(`${where}: a grammar needs "extensions" or "fileNames" to apply to any file`);
      return null;
    }
    return {
      language,
      wasm,
      symbol: readOptionalString(entry, "symbol", where, problems),
      highlights: readOptionalPackagePath(entry, "highlights", where, problems),
      injections: readOptionalPackagePath(entry, "injections", where, problems),
      locals: readOptionalPackagePath(entry, "locals", where, problems),
      extensions,
      fileNames,
    };
  };
}

/** The reader of one `languageServers` entry. */
function readLanguageServer(problems: string[]): (entry: unknown, where: string) => LanguageServerContribution | null {
  return (entry, where) => {
    if (!isPlainObject(entry)) {
      problems.push(`${where}: must be an object`);
      return null;
    }
    const id = readIdentifier(entry, where, problems);
    const command = readString(entry, "command", where, problems);
    const languageId = readString(entry, "languageId", where, problems);
    if (id === undefined || command === undefined || languageId === undefined) {
      return null;
    }
    const extensions = readStringList(entry, "extensions", where, problems, true);
    const fileNames = readStringList(entry, "fileNames", where, problems, true);
    if (extensions.length === 0 && fileNames.length === 0) {
      problems.push(`${where}: a language server needs "extensions" or "fileNames" to serve any file`);
      return null;
    }
    const server: LanguageServerContribution = {
      id,
      name: textOr(entry.name, id),
      command,
      args: readStringList(entry, "args", where, problems, true),
      languageId,
      extensions,
      fileNames,
      rootMarkers: readStringList(entry, "rootMarkers", where, problems, true),
    };
    const install = readInstall(entry, where, problems);
    if (install !== null) {
      server.install = install;
    }
    return server;
  };
}

/** The recipe of an entry that has an `install` field, or null when it has none or it is wrong. */
function readInstall(entry: Record<string, unknown>, where: string, problems: string[]): InstallRecipe | null {
  if (entry.install === undefined) {
    return null;
  }
  return parseRecipe(entry.install, `${where} install`, problems);
}

/** The reader of one `tools` entry. */
function readTool(problems: string[]): (entry: unknown, where: string) => ToolContribution | null {
  return (entry, where) => {
    if (!isPlainObject(entry)) {
      problems.push(`${where}: must be an object`);
      return null;
    }
    const id = readIdentifier(entry, where, problems);
    const install = parseRecipe(entry.install, `${where} install`, problems);
    if (id === undefined || install === null) {
      return null;
    }
    return { id, name: textOr(entry.name, id), install };
  };
}

/** The reader of one `themes` entry. */
function readTheme(problems: string[]): (entry: unknown, where: string) => ThemeContribution | null {
  return (entry, where) => {
    if (!isPlainObject(entry)) {
      problems.push(`${where}: must be an object`);
      return null;
    }
    const id = readIdentifier(entry, where, problems);
    const scheme = entry.scheme;
    if (scheme !== "dark" && scheme !== "light") {
      problems.push(`${where}: "scheme" must be "dark" or "light"`);
      return null;
    }
    const file = readOptionalPackagePath(entry, "file", where, problems);
    const tokens = readTokens(entry.tokens, where, problems);
    if (id === undefined || (file === undefined && tokens === undefined)) {
      problems.push(`${where}: a theme needs a "file" or "tokens"`);
      return null;
    }
    return { id, name: textOr(entry.name, id), scheme, file, tokens };
  };
}

/** Inline theme tokens: colour names mapped to colour text. */
function readTokens(value: unknown, where: string, problems: string[]): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    problems.push(`${where}: "tokens" must map names to colours`);
    return undefined;
  }
  return value as Record<string, string>;
}

/** The declared settings; fields that are wrong are dropped with a problem. */
function readSettings(value: unknown, where: string, problems: string[]): Record<string, SettingField> {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    problems.push(`${where}: "settings" must map names to fields`);
    return {};
  }
  const fields: Record<string, SettingField> = {};
  for (const [name, declared] of Object.entries(value)) {
    const field = readSettingField(declared, `${where} settings.${name}`, problems);
    if (field !== null) {
      fields[name] = field;
    }
  }
  return fields;
}

const FIELD_TYPES = ["string", "number", "boolean", "enum", "color", "keybinding"];

/** One declared setting, or null with a problem when it cannot be drawn or defaulted. */
function readSettingField(value: unknown, where: string, problems: string[]): SettingField | null {
  if (!isPlainObject(value) || typeof value.type !== "string" || !FIELD_TYPES.includes(value.type)) {
    problems.push(`${where}: needs a "type" of ${FIELD_TYPES.join(", ")}`);
    return null;
  }
  if (typeof value.label !== "string" || value.label === "") {
    problems.push(`${where}: needs a "label"`);
    return null;
  }
  if (value.type === "enum" && !hasChoices(value.options)) {
    problems.push(`${where}: an enum needs "options", a list of value and label pairs`);
    return null;
  }
  const field = value as unknown as SettingField;
  const problem = describeFieldProblem(field, field.default);
  if (problem !== null) {
    problems.push(`${where}: its default ${problem}`);
    return null;
  }
  return field;
}

/** Whether an enum's options are a list of value and label pairs or the name of a list a plugin supplies. */
function hasChoices(options: unknown): boolean {
  if (typeof options === "string") {
    return true;
  }
  if (!Array.isArray(options)) {
    return false;
  }
  return options.every((option) => isPlainObject(option) && typeof option.value === "string" && typeof option.label === "string");
}

/** The `id` of an entry: letters, digits, dots, dashes and underscores, so a row id built from it stays readable. */
function readIdentifier(entry: Record<string, unknown>, where: string, problems: string[]): string | undefined {
  const id = readString(entry, "id", where, problems);
  if (id === undefined) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    problems.push(`${where}: "id" may only hold letters, digits, dots, dashes and underscores`);
    return undefined;
  }
  return id;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
