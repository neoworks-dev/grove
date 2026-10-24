// How a tool is installed. A recipe is data in an extension's manifest (or in Grove's own list
// of language servers), and the Rust host runs it: Grove downloads or builds the tool into its
// own tools directory, without root, and puts the directory's `bin` first on the server
// lookup path. This file is the shape and its validation; the installing lives in `src/tools/`.

import { isPlainObject, readOptionalString, readString, readStringList } from "./reading";

/** The platforms a release asset can be named for, as `<os>-<arch>`. */
export const PLATFORMS = ["linux-x64", "linux-arm64", "macos-x64", "macos-arm64", "windows-x64", "windows-arm64"] as const;

export type PlatformKey = (typeof PLATFORMS)[number];

/** How a downloaded release asset holds the tool; `auto` reads it from the asset's file name. */
export type ArchiveKind = "auto" | "none" | "gz" | "tar.gz" | "zip";

/** A binary taken from a GitHub release. `{version}` in an asset name stands for the release tag without its `v`. */
export interface GithubReleaseRecipe {
  kind: "github-release";
  /** `owner/name`. */
  repo: string;
  /** The release tag to install; the latest release when left out. */
  tag?: string;
  /** The asset to download for each platform; a platform with no entry cannot install the tool. */
  assets: Partial<Record<PlatformKey, string>>;
  /** How the asset holds the tool; read from the asset's name when left out. */
  archive: ArchiveKind;
  /** The executables the tool provides, found by name inside the extracted files. */
  binaries: string[];
}

/** A package installed with npm (or bun) into a private prefix. */
export interface NpmRecipe {
  kind: "npm";
  package: string;
  version?: string;
  /** The executables the package puts in `node_modules/.bin`. */
  binaries: string[];
}

/** A package installed with pip into a virtual environment of its own. */
export interface PipRecipe {
  kind: "pip";
  package: string;
  version?: string;
  binaries: string[];
}

/** A crate built with `cargo install --root`. */
export interface CargoRecipe {
  kind: "cargo";
  crate: string;
  version?: string;
  binaries: string[];
}

/** A Go program built with `go install` into a directory of its own, which needs the Go toolchain. */
export interface GoRecipe {
  kind: "go";
  /** The package path, such as `golang.org/x/tools/gopls`. */
  package: string;
  version?: string;
  binaries: string[];
}

export type InstallRecipe = GithubReleaseRecipe | NpmRecipe | PipRecipe | CargoRecipe | GoRecipe;

const ARCHIVE_KINDS: ArchiveKind[] = ["auto", "none", "gz", "tar.gz", "zip"];

/** Reads a recipe, or returns null after adding what is wrong with it to `problems`. */
export function parseRecipe(value: unknown, where: string, problems: string[]): InstallRecipe | null {
  if (!isPlainObject(value)) {
    problems.push(`${where}: a recipe must be an object`);
    return null;
  }
  const kind = readString(value, "kind", where, problems);
  if (kind === "github-release") {
    return parseGithubRelease(value, where, problems);
  }
  if (kind === "npm") {
    return parsePackageRecipe(value, "npm", "package", where, problems);
  }
  if (kind === "pip") {
    return parsePackageRecipe(value, "pip", "package", where, problems);
  }
  if (kind === "cargo") {
    return parsePackageRecipe(value, "cargo", "crate", where, problems);
  }
  if (kind === "go") {
    return parsePackageRecipe(value, "go", "package", where, problems);
  }
  if (kind !== undefined) {
    problems.push(`${where}: unknown recipe kind "${kind}"`);
  }
  return null;
}

/** A GitHub release recipe: the repository, the asset per platform and how to unpack it. */
function parseGithubRelease(
  value: Record<string, unknown>,
  where: string,
  problems: string[],
): GithubReleaseRecipe | null {
  const repo = readString(value, "repo", where, problems);
  const assets = parseAssets(value.assets, where, problems);
  const binaries = readBinaries(value, where, problems);
  const archive = parseArchive(value.archive, where, problems);
  if (repo === undefined || assets === null || archive === null || binaries.length === 0) {
    return null;
  }
  const recipe: GithubReleaseRecipe = { kind: "github-release", repo, assets, archive, binaries };
  const tag = readOptionalString(value, "tag", where, problems);
  if (tag !== undefined) {
    recipe.tag = tag;
  }
  return recipe;
}

/** The executables a recipe provides; a recipe with none has nothing to put on the lookup path. */
function readBinaries(value: Record<string, unknown>, where: string, problems: string[]): string[] {
  const binaries = readStringList(value, "binaries", where, problems);
  if (binaries.length === 0) {
    problems.push(`${where}: "binaries" must name at least one executable`);
  }
  return binaries;
}

/** The asset names by platform, or null when none is usable. */
function parseAssets(value: unknown, where: string, problems: string[]): Partial<Record<PlatformKey, string>> | null {
  if (!isPlainObject(value)) {
    problems.push(`${where}: "assets" must map platforms to asset names`);
    return null;
  }
  const assets: Partial<Record<PlatformKey, string>> = {};
  for (const [platform, asset] of Object.entries(value)) {
    if (!PLATFORMS.includes(platform as PlatformKey)) {
      problems.push(`${where}: "${platform}" is not a platform (${PLATFORMS.join(", ")})`);
      continue;
    }
    if (typeof asset !== "string" || asset === "") {
      problems.push(`${where}: the asset for ${platform} must be a file name`);
      continue;
    }
    assets[platform as PlatformKey] = asset;
  }
  if (Object.keys(assets).length === 0) {
    problems.push(`${where}: "assets" names no platform`);
    return null;
  }
  return assets;
}

/** The archive kind, `auto` when left out, or null for one Grove cannot unpack. */
function parseArchive(value: unknown, where: string, problems: string[]): ArchiveKind | null {
  if (value === undefined) {
    return "auto";
  }
  if (typeof value === "string" && ARCHIVE_KINDS.includes(value as ArchiveKind)) {
    return value as ArchiveKind;
  }
  problems.push(`${where}: "archive" must be one of ${ARCHIVE_KINDS.join(", ")}`);
  return null;
}

/** An npm, pip, cargo or go recipe, which differ only in what the package field is called. */
function parsePackageRecipe(
  value: Record<string, unknown>,
  kind: "npm" | "pip" | "cargo" | "go",
  packageField: string,
  where: string,
  problems: string[],
): InstallRecipe | null {
  const name = readString(value, packageField, where, problems);
  const binaries = readBinaries(value, where, problems);
  if (name === undefined || binaries.length === 0) {
    return null;
  }
  const version = readOptionalString(value, "version", where, problems);
  if (kind === "cargo") {
    return { kind, crate: name, version, binaries };
  }
  return { kind, package: name, version, binaries };
}
