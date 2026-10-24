// A small npm registry for trying extensions without publishing them: it serves the extensions in
// the directories it is given, packed as npm would, from the endpoints Grove uses (the search,
// a package's document and its tarball).
//
//   bun scripts/mockRegistry.mjs 4873 samples/extensions/grove-hello samples/extensions/grove-night-theme
//
// then set the `registry` setting of the extensions view to http://127.0.0.1:4873.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Packs a directory with `npm pack` and reads what a registry would publish about it. */
function pack(directory, destination) {
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], { cwd: directory, encoding: "utf8" });
  // Older npm prints a list, newer npm an object keyed by the package.
  const parsed = JSON.parse(output);
  let packed = Object.values(parsed)[0];
  if (Array.isArray(parsed)) {
    packed = parsed[0];
  }
  const bytes = readFileSync(join(destination, packed.filename));
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  return {
    manifest,
    filename: packed.filename,
    bytes,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
  };
}

/**
 * Starts the registry on a port (0 for any) with the given extension directories. Resolves with
 * the server, its address and the package list, which a test may change to publish a new version.
 */
export function startMockRegistry(directories, port = 0) {
  const destination = mkdtempSync(join(tmpdir(), "grove-registry-"));
  const packages = directories.map((directory) => pack(resolve(directory), destination));
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${server.port}`;
      if (url.pathname === "/-/v1/search") {
        return Response.json(search(packages, url.searchParams.get("text") ?? "", Number(url.searchParams.get("size") ?? 20)));
      }
      if (url.pathname.startsWith("/tarballs/")) {
        const found = packages.find((entry) => `/tarballs/${entry.filename}` === url.pathname);
        if (found === undefined) {
          return new Response("not found", { status: 404 });
        }
        return new Response(found.bytes);
      }
      const name = decodeURIComponent(url.pathname.slice(1));
      const found = packages.find((entry) => entry.manifest.name === name);
      if (found === undefined) {
        return new Response("not found", { status: 404 });
      }
      return Response.json(document(found, origin));
    },
  });
  return { server, packages, address: `http://127.0.0.1:${server.port}` };
}

/** The search endpoint's answer: the packages that match every word of the text but the keyword qualifier. */
function search(packages, text, size) {
  const words = text.split(/\s+/).filter((word) => word !== "" && !word.startsWith("keywords:"));
  const matching = packages.filter((entry) => {
    const haystack = `${entry.manifest.name} ${entry.manifest.description} ${(entry.manifest.keywords ?? []).join(" ")}`.toLowerCase();
    return words.every((word) => haystack.includes(word.toLowerCase()));
  });
  return {
    objects: matching.slice(0, size).map((entry) => ({
      package: {
        name: entry.manifest.name,
        version: entry.manifest.version,
        description: entry.manifest.description,
        keywords: entry.manifest.keywords,
        publisher: { username: "grove-samples" },
      },
    })),
    total: matching.length,
  };
}

/** A package's document, with its one version. */
function document(entry, origin) {
  const { name, version } = entry.manifest;
  return {
    name,
    "dist-tags": { latest: version },
    versions: {
      [version]: { name, version, dist: { tarball: `${origin}/tarballs/${entry.filename}`, integrity: entry.integrity, shasum: entry.shasum } },
    },
  };
}

if (import.meta.main) {
  const [port, ...directories] = process.argv.slice(2);
  if (!port || directories.length === 0) {
    console.error("usage: bun scripts/mockRegistry.mjs PORT EXTENSION_DIRECTORY...");
    process.exit(2);
  }
  const { address, packages } = startMockRegistry(directories, Number(port));
  console.log(`serving ${packages.map((entry) => entry.manifest.name).join(", ")} at ${address}`);
}
