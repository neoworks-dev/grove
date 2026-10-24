// Where installed extensions live and how they are read. Each extension is a directory under
// `extensions/` in Grove's data directory (the sidecar's, so `GROVE_SIDECAR_DATA` moves it),
// holding the package as npm published it, and `extensions/state.json` lists the ones the user
// switched off. The file access is a parameter so tests run without a host.

import { parseManifest, type ExtensionManifest } from "./manifest";

export interface ExtensionFiles {
  /** Grove's data directory. */
  dataDirectory(): Promise<string>;
  /** The file's text, or null when it does not exist. Other failures reject. */
  readIfExists(path: string): Promise<string | null>;
  /** The names of the directories directly inside a directory; empty when it does not exist. */
  listDirectories(path: string): Promise<string[]>;
  /** Writes a file, creating its folders first. */
  writeText(path: string, text: string): Promise<void>;
}

/** An extension found on disk, usable or not. */
export interface InstalledExtension {
  /** The package name; the directory's name when the manifest could not be read. */
  name: string;
  version: string;
  /** Absolute path of the extension's directory. */
  directory: string;
  /** Null when `package.json` is missing or is not an extension. */
  manifest: ExtensionManifest | null;
  /** Everything wrong with the manifest, and, once loaded, with the parts that failed. */
  problems: string[];
  enabled: boolean;
}

/** The directory all extensions are installed under. */
export function extensionsDirectory(dataDirectory: string): string {
  return `${dataDirectory}/extensions`;
}

/** The file that lists the switched-off extensions. */
export function statePath(dataDirectory: string): string {
  return `${extensionsDirectory(dataDirectory)}/state.json`;
}

/** The directory name for a package: a scope's slash becomes a plus, so `@a/b` is `@a+b`. */
export function directoryNameOf(packageName: string): string {
  return packageName.replace("/", "+");
}

/** The names of the extensions the user disabled, read from the state file's text; unreadable text means none. */
export function parseDisabled(text: string | null): string[] {
  if (text === null) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as { disabled?: unknown };
    if (Array.isArray(parsed.disabled)) {
      return parsed.disabled.filter((name): name is string => typeof name === "string");
    }
  } catch {
    return [];
  }
  return [];
}

/** The state file's text for a list of disabled extensions. */
export function stateText(disabled: string[]): string {
  return `${JSON.stringify({ disabled }, null, 2)}\n`;
}

/** Reads the disabled list from the data directory. */
export async function readDisabled(files: ExtensionFiles): Promise<string[]> {
  const data = await files.dataDirectory();
  return parseDisabled(await files.readIfExists(statePath(data)));
}

/** Reads every extension installed under the data directory, in name order. */
export async function readInstalled(files: ExtensionFiles): Promise<InstalledExtension[]> {
  const data = await files.dataDirectory();
  const root = extensionsDirectory(data);
  const disabled = await readDisabled(files);
  const names = await files.listDirectories(root);
  const installed: InstalledExtension[] = [];
  for (const directoryName of names.sort()) {
    installed.push(await readOne(files, `${root}/${directoryName}`, directoryName, disabled));
  }
  return installed;
}

/** One extension's directory, read; a directory without a usable manifest comes back with its problems. */
async function readOne(
  files: ExtensionFiles,
  directory: string,
  directoryName: string,
  disabled: string[],
): Promise<InstalledExtension> {
  const source = `${directory}/package.json`;
  let text: string | null = null;
  try {
    text = await files.readIfExists(source);
  } catch (error) {
    return unreadable(directory, directoryName, `${source}: could not be read (${describeError(error)})`);
  }
  if (text === null) {
    return unreadable(directory, directoryName, `${source}: no package.json`);
  }
  const parsed = parseManifest(text, source);
  if (parsed.manifest === null) {
    return unreadable(directory, directoryName, ...parsed.problems);
  }
  const name = parsed.manifest.name;
  return {
    name,
    version: parsed.manifest.version,
    directory,
    manifest: parsed.manifest,
    problems: parsed.problems,
    enabled: !disabled.includes(name),
  };
}

/** The entry for a directory that cannot be loaded. */
function unreadable(directory: string, directoryName: string, ...problems: string[]): InstalledExtension {
  return { name: directoryName, version: "", directory, manifest: null, problems, enabled: false };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
