// The npm registry as extensions use it: search for packages with the `grove-extension` keyword,
// look a package up for its newest version and tarball, and download the tarball. It talks
// through a `fetch`, which the app passes in as svelte-gpui's own and tests replace.

import { EXTENSION_KEYWORD } from "./manifest";

/** The part of `fetch` this client uses. */
export type FetchFunction = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** A package a search found. */
export interface RegistryPackage {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  /** Who published it, when the registry says. */
  publisher: string;
}

/** One published version of a package and where to get it. */
export interface PackageRelease {
  name: string;
  version: string;
  tarball: string;
  /** `sha512-<base64>` of the tarball. */
  integrity: string | null;
  /** The hex SHA-1 older registries publish instead. */
  shasum: string | null;
}

export interface RegistryOptions {
  /** The registry's base address, read on each call so a changed setting applies at once. */
  baseUrl: () => string;
  fetch: FetchFunction;
}

/** The address npm's own registry is at. */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export class NpmRegistry {
  private options: RegistryOptions;

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  /**
   * The extensions whose name, description or keywords match the text; every extension for an
   * empty text. Packages the registry returns without the keyword are left out, since a registry
   * may ignore the keyword in the query.
   */
  async search(text: string, limit = 30): Promise<RegistryPackage[]> {
    const query = `keywords:${EXTENSION_KEYWORD} ${text}`.trim();
    const address = `${this.base()}/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`;
    const body = await this.getJson(address);
    const objects = (body as { objects?: unknown }).objects;
    if (!Array.isArray(objects)) {
      throw new Error("the registry's answer to the search has no results list");
    }
    const found: RegistryPackage[] = [];
    for (const object of objects) {
      const entry = readSearchEntry(object);
      if (entry !== null && entry.keywords.includes(EXTENSION_KEYWORD)) {
        found.push(entry);
      }
    }
    return found;
  }

  /** A version of a package: the one asked for, or the `latest` tag when none is. */
  async resolve(name: string, version?: string): Promise<PackageRelease> {
    const document = (await this.getJson(`${this.base()}/${name.replace("/", "%2F")}`, true)) as PackageDocument;
    let wanted = version;
    if (wanted === undefined) {
      wanted = document["dist-tags"]?.latest;
    }
    if (wanted === undefined) {
      throw new Error(`${name} has no published version`);
    }
    const release = document.versions?.[wanted];
    if (release === undefined || typeof release.dist?.tarball !== "string") {
      throw new Error(`${name} has no version ${wanted} on the registry`);
    }
    return {
      name,
      version: wanted,
      tarball: release.dist.tarball,
      integrity: stringOrNull(release.dist.integrity),
      shasum: stringOrNull(release.dist.shasum),
    };
  }

  /** The tarball of a release, as bytes. */
  async download(release: PackageRelease): Promise<ArrayBuffer> {
    const response = await this.options.fetch(release.tarball);
    if (!response.ok) {
      throw new Error(`downloading ${release.name} ${release.version} failed: ${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
  }

  /** The registry's address without a trailing slash. */
  private base(): string {
    return this.options.baseUrl().replace(/\/+$/, "");
  }

  /** Fetches an address and reads its JSON. `abbreviated` asks for npm's short package document, which is much smaller. */
  private async getJson(address: string, abbreviated = false): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (abbreviated) {
      headers.accept = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8";
    }
    let response;
    try {
      response = await this.options.fetch(address, { headers });
    } catch (error) {
      throw new Error(`could not reach the registry at ${this.base()} (${describeError(error)})`);
    }
    if (!response.ok) {
      throw new Error(`the registry answered ${response.status} ${response.statusText} for ${address}`);
    }
    return response.json();
  }
}

interface PackageDocument {
  "dist-tags"?: { latest?: string };
  versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown; shasum?: unknown } }>;
}

/** One search result, or null when it has no usable name and version. */
function readSearchEntry(object: unknown): RegistryPackage | null {
  const found = (object as { package?: Record<string, unknown> } | null)?.package;
  if (found === undefined || typeof found.name !== "string" || typeof found.version !== "string") {
    return null;
  }
  let keywords: string[] = [];
  if (Array.isArray(found.keywords)) {
    keywords = found.keywords.filter((keyword): keyword is string => typeof keyword === "string");
  }
  return {
    name: found.name,
    version: found.version,
    description: textOf(found.description),
    keywords,
    publisher: textOf((found.publisher as { username?: unknown } | undefined)?.username),
  };
}

/** A value that is text, or null. */
function stringOrNull(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return null;
}

/** A value that is text, or the empty string. */
function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return "";
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
