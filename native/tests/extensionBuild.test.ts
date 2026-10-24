import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtension } from "../scripts/buildExtension.mjs";
import { defineSettings, setting } from "../kernel/settings";
import { evaluateExtensionScript, parseManifest } from "../kernel/extensions";

const SAMPLE = join(import.meta.dir, "..", "samples", "extensions", "grove-hello");

describe("the sample extension", () => {
  test("builds into a script that asks the app for its modules and contributes a plugin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grove-extension-build-"));
    await cp(join(SAMPLE, "package.json"), join(directory, "package.json"));
    await cp(join(SAMPLE, "src"), join(directory, "src"), { recursive: true });
    await buildExtension(directory);

    const manifest = parseManifest(await readFile(join(directory, "package.json"), "utf8"), "package.json");
    expect(manifest.problems).toEqual([]);
    const script = await readFile(join(directory, manifest.manifest!.plugins[0].main), "utf8");
    expect(script).not.toContain("SElement");
    expect(script.length).toBeLessThan(20_000);

    const requested: string[] = [];
    const modules = new Proxy(
      { "@grove/extension": { defineSettings, setting, colors: {} } } as Record<string, unknown>,
      {
        has: () => true,
        get(target, name: string) {
          requested.push(name);
          return target[name] ?? {};
        },
      },
    );
    const plugin = evaluateExtensionScript(script, "grove-hello/hello.js", modules) as {
      Config: { fields: Record<string, { default: string }> };
      inject: string[];
    };
    expect(plugin.inject).toEqual(["slots"]);
    expect(plugin.Config.fields.greeting.default).toBe("Hello from an extension");
    expect(new Set(requested)).toEqual(new Set(["@grove/extension", "@neoworks/svelte-gpui/ui", "svelte/internal/client", "svelte/internal/disclose-version"]));
  });
});
