import { describe, expect, test } from "bun:test";
import { parseManifest } from "../kernel/extensions";
import { parseRecipe } from "../kernel/extensions/recipes";

/** A package.json text with a `grove` field. */
function packageText(grove: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: "grove-sample", version: "1.2.3", description: "A sample", grove, ...extra });
}

describe("parseManifest", () => {
  test("reads every kind of contribution", () => {
    const text = packageText({
      title: "Sample",
      plugins: [{ id: "hello", main: "dist/hello.js", title: "Hello" }],
      grammars: [{ language: "toml", wasm: "grammars/toml.wasm", highlights: "queries/highlights.scm", extensions: ["toml"], fileNames: ["Cargo.lock"] }],
      languageServers: [
        {
          id: "taplo",
          name: "Taplo",
          command: "taplo",
          args: ["lsp", "stdio"],
          languageId: "toml",
          extensions: ["toml"],
          install: { kind: "github-release", repo: "tamasfe/taplo", assets: { "linux-x64": "taplo-linux-x86_64.gz" }, archive: "gz", binaries: ["taplo"] },
        },
      ],
      tools: [{ id: "prettier", install: { kind: "npm", package: "prettier", binaries: ["prettier"] } }],
      themes: [{ id: "night", name: "Night", scheme: "dark", tokens: { accent: "#ff00ff" } }],
      settings: { greeting: { type: "string", label: "Greeting", default: "hi" } },
    });
    const { manifest, problems } = parseManifest(text, "package.json");
    expect(problems).toEqual([]);
    expect(manifest?.name).toBe("grove-sample");
    expect(manifest?.version).toBe("1.2.3");
    expect(manifest?.title).toBe("Sample");
    expect(manifest?.plugins).toEqual([{ id: "hello", main: "dist/hello.js", title: "Hello", description: undefined, source: undefined }]);
    expect(manifest?.grammars[0].fileNames).toEqual(["Cargo.lock"]);
    expect(manifest?.languageServers[0].install?.kind).toBe("github-release");
    expect(manifest?.languageServers[0].args).toEqual(["lsp", "stdio"]);
    expect(manifest?.tools[0].install.kind).toBe("npm");
    expect(manifest?.themes[0].tokens).toEqual({ accent: "#ff00ff" });
    expect(Object.keys(manifest?.settings ?? {})).toEqual(["greeting"]);
  });

  test("a package without a grove field contributes nothing", () => {
    const { manifest, problems } = parseManifest(JSON.stringify({ name: "left-pad" }), "package.json");
    expect(manifest).toBeNull();
    expect(problems[0]).toContain("no \"grove\" field");
  });

  test("a part that is wrong is dropped and named, and the rest still loads", () => {
    const { manifest, problems } = parseManifest(
      packageText({
        plugins: [{ id: "ok", main: "dist/ok.js" }, { id: "bad id", main: "dist/x.js" }, { id: "up", main: "../outside.js" }],
        grammars: [{ language: "toml", wasm: "toml.wasm" }],
        themes: [{ id: "t", name: "T", scheme: "sepia", tokens: {} }],
        settings: { broken: { type: "number", label: "Broken", default: "text" }, fine: { type: "boolean", label: "Fine", default: true } },
      }),
      "package.json",
    );
    expect(manifest?.plugins.map((plugin) => plugin.id)).toEqual(["ok"]);
    expect(manifest?.grammars).toEqual([]);
    expect(manifest?.themes).toEqual([]);
    expect(Object.keys(manifest?.settings ?? {})).toEqual(["fine"]);
    expect(problems.some((problem) => problem.includes("inside the package"))).toBe(true);
    expect(problems.some((problem) => problem.includes("letters, digits"))).toBe(true);
    expect(problems.some((problem) => problem.includes("needs \"extensions\" or \"fileNames\""))).toBe(true);
    expect(problems.some((problem) => problem.includes("scheme"))).toBe(true);
    expect(problems.some((problem) => problem.includes("default must be a number"))).toBe(true);
  });

  test("text that is not JSON is a problem, not a throw", () => {
    expect(parseManifest("{nope", "package.json").manifest).toBeNull();
    expect(parseManifest("[]", "package.json").problems[0]).toContain("expected a JSON object");
  });
});

describe("parseRecipe", () => {
  test("reads the four kinds", () => {
    const problems: string[] = [];
    const release = parseRecipe({ kind: "github-release", repo: "a/b", assets: { "linux-x64": "b.tar.gz" }, archive: "tar.gz", binaries: ["b"] }, "r", problems);
    const npm = parseRecipe({ kind: "npm", package: "yaml-language-server", binaries: ["yaml-language-server"] }, "r", problems);
    const pip = parseRecipe({ kind: "pip", package: "ruff", version: "0.5.0", binaries: ["ruff"] }, "r", problems);
    const cargo = parseRecipe({ kind: "cargo", crate: "taplo-cli", binaries: ["taplo"] }, "r", problems);
    const go = parseRecipe({ kind: "go", package: "golang.org/x/tools/gopls", binaries: ["gopls"] }, "r", problems);
    expect(problems).toEqual([]);
    expect([release?.kind, npm?.kind, pip?.kind, cargo?.kind, go?.kind]).toEqual(["github-release", "npm", "pip", "cargo", "go"]);
    expect(go).toMatchObject({ package: "golang.org/x/tools/gopls" });
    expect(cargo).toMatchObject({ crate: "taplo-cli" });
    expect(pip).toMatchObject({ version: "0.5.0" });
  });

  test("the archive is read from the asset's name unless the recipe says", () => {
    const problems: string[] = [];
    const unspecified = parseRecipe({ kind: "github-release", repo: "a/b", assets: { "linux-x64": "b.zip" }, binaries: ["b"] }, "r", problems);
    expect(unspecified).toMatchObject({ archive: "auto" });
    expect(parseRecipe({ kind: "github-release", repo: "a/b", assets: { "linux-x64": "b" }, archive: "tar.xz", binaries: ["b"] }, "r", problems)).toBeNull();
    expect(problems[0]).toContain("auto, none, gz, tar.gz, zip");
  });

  test("refuses what the installer could not run", () => {
    const problems: string[] = [];
    expect(parseRecipe({ kind: "apt", package: "x" }, "r", problems)).toBeNull();
    expect(parseRecipe({ kind: "github-release", repo: "a/b", assets: { "plan9-x64": "b" }, binaries: ["b"] }, "r", problems)).toBeNull();
    expect(parseRecipe({ kind: "npm", package: "x", binaries: [] }, "r", problems)).toBeNull();
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});
