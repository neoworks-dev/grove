import { describe, expect, test } from "bun:test";
import { NpmRegistry, compareVersions, isNewer } from "../kernel/extensions";
import { FakeRegistry } from "./support/fakeRegistry";

/** A registry client for the fake. */
function clientFor(registry: FakeRegistry): NpmRegistry {
  return new NpmRegistry({ baseUrl: () => "https://registry.test/", fetch: registry.fetch });
}

describe("NpmRegistry", () => {
  test("searches with the extension keyword and the typed words", async () => {
    const registry = new FakeRegistry();
    registry.publish("grove-night", "1.0.0", { themes: [] });
    registry.publish("grove-other", "2.0.0", { themes: [] });
    const found = await clientFor(registry).search("night");
    expect(found.map((entry) => entry.name)).toEqual(["grove-night"]);
    expect(registry.requests[0]).toBe("https://registry.test/-/v1/search?text=keywords%3Agrove-extension%20night&size=30");
  });

  test("an empty search lists every extension, and a package without the keyword is left out", async () => {
    const registry = new FakeRegistry();
    registry.publish("grove-a", "1.0.0", {});
    registry.publish("left-pad", "1.0.0", {}, {}, ["string"]);
    const found = await clientFor(registry).search("");
    expect(found.map((entry) => entry.name)).toEqual(["grove-a"]);
    expect(found[0]).toMatchObject({ version: "1.0.0", publisher: "someone", description: "grove-a description" });
  });

  test("resolves the latest version, or the one asked for, with where to download it", async () => {
    const registry = new FakeRegistry();
    registry.publish("@scope/ext", "1.2.0", {});
    const client = clientFor(registry);
    const release = await client.resolve("@scope/ext");
    expect(release).toMatchObject({ name: "@scope/ext", version: "1.2.0", integrity: "sha512-abc", shasum: "def" });
    expect(registry.requests[0]).toBe("https://registry.test/@scope%2Fext");
    await expect(client.resolve("@scope/ext", "9.9.9")).rejects.toThrow("no version 9.9.9");
    await expect(client.resolve("missing")).rejects.toThrow("answered 404");
  });

  test("downloads the tarball's bytes", async () => {
    const registry = new FakeRegistry();
    registry.publish("grove-a", "1.0.0", {}, { "dist/a.js": "x" });
    const client = clientFor(registry);
    const bytes = await client.download(await client.resolve("grove-a"));
    expect(new TextDecoder().decode(bytes)).toContain("dist/a.js");
  });

  test("an unreachable registry is explained with its address", async () => {
    const registry = new FakeRegistry();
    registry.failing = "/-/v1/search";
    await expect(clientFor(registry).search("")).rejects.toThrow("could not reach the registry at https://registry.test (connection refused)");
  });
});

describe("version comparison", () => {
  test("orders releases and prereleases", () => {
    expect(isNewer("1.2.0", "1.1.9")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("0.9.0", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "1.0.0-beta.2")).toBe(true);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(isNewer("v2.0.0", "1.9.9")).toBe(true);
  });

  test("a version that cannot be read is never newer", () => {
    expect(isNewer("latest", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "next")).toBe(false);
  });
});
