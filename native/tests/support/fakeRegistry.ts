import type { FetchFunction } from "../../kernel/extensions";

/** One version of an extension on the fake registry: its files, which stand in for the tarball. */
export interface PublishedPackage {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  files: Record<string, string>;
}

/** A registry answering the endpoints Grove uses, with packages that can be published while a test runs. */
export class FakeRegistry {
  packages: PublishedPackage[] = [];
  requests: string[] = [];
  /** Makes the next request for this path part fail, as an unreachable server would. */
  failing: string | null = null;

  /** Publishes a package whose `package.json` is made from its fields and `grove` manifest. */
  publish(name: string, version: string, grove: unknown, files: Record<string, string> = {}, keywords = ["grove-extension"]): void {
    const manifest = JSON.stringify({ name, version, description: `${name} description`, keywords, grove });
    this.packages = this.packages.filter((entry) => entry.name !== name);
    this.packages.push({ name, version, description: `${name} description`, keywords, files: { ...files, "package.json": manifest } });
  }

  /** The `fetch` that reads from this registry. */
  fetch: FetchFunction = async (url) => {
    this.requests.push(url);
    const address = new URL(url);
    if (this.failing !== null && url.includes(this.failing)) {
      throw new Error("connection refused");
    }
    if (address.pathname === "/-/v1/search") {
      return json(this.searchBody(address.searchParams.get("text") ?? ""));
    }
    if (address.pathname.startsWith("/tarballs/")) {
      return this.tarball(address.pathname.slice("/tarballs/".length));
    }
    return this.document(decodeURIComponent(address.pathname.slice(1)));
  };

  /** The search endpoint's answer for a query. Packages without the keyword are included on purpose, as a lax registry would. */
  private searchBody(text: string): unknown {
    const words = text.split(" ").filter((word) => word !== "" && !word.startsWith("keywords:"));
    const matching = this.packages.filter((entry) => words.every((word) => `${entry.name} ${entry.description}`.includes(word)));
    return {
      objects: matching.map((entry) => ({
        package: { name: entry.name, version: entry.version, description: entry.description, keywords: entry.keywords, publisher: { username: "someone" } },
      })),
    };
  }

  /** A package's document, the way the registry serves it. */
  private document(name: string): ReturnType<FetchFunction> {
    const found = this.packages.find((entry) => entry.name === name);
    if (found === undefined) {
      return Promise.resolve(status(404, "Not Found"));
    }
    const dist = { tarball: `https://registry.test/tarballs/${found.name.replace("/", "+")}-${found.version}.tgz`, integrity: "sha512-abc", shasum: "def" };
    return Promise.resolve(json({ name, "dist-tags": { latest: found.version }, versions: { [found.version]: { name, version: found.version, dist } } }));
  }

  /** A tarball: the JSON of the package's files, which the fake disk unpacks. */
  private tarball(file: string): ReturnType<FetchFunction> {
    const found = this.packages.find((entry) => file === `${entry.name.replace("/", "+")}-${entry.version}.tgz`);
    if (found === undefined) {
      return Promise.resolve(status(404, "Not Found"));
    }
    const bytes = new TextEncoder().encode(JSON.stringify(found.files));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return Promise.resolve({ ...status(200, "OK"), arrayBuffer: async () => buffer });
  }
}

/** An answer with a JSON body. */
function json(body: unknown): Awaited<ReturnType<FetchFunction>> {
  return { ...status(200, "OK"), json: async () => body };
}

/** An answer with a status and nothing else. */
function status(code: number, text: string): Awaited<ReturnType<FetchFunction>> {
  return {
    ok: code >= 200 && code < 300,
    status: code,
    statusText: text,
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}
