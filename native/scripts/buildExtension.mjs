// Builds an extension's plugin scripts: `bun scripts/buildExtension.mjs path/to/extension`.
// Each plugin in the extension's `grove.plugins` that names a `source` is bundled into its
// `main`. The modules the app shares (Svelte, svelte-gpui, the extension system and
// `@grove/extension`) stay external: the script asks the app for them with `require`, so there
// is one copy of each. Everything else the plugin imports is bundled into the script.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "@neoworks/svelte-gpui/build";

/** The modules every extension script gets from the app instead of carrying its own copy. */
export const SHARED = [
  "svelte",
  "svelte/*",
  "@neoworks/svelte-gpui",
  "@neoworks/svelte-gpui/ui",
  "@neoworks/extension-system",
  "@grove/extension",
];

/**
 * An esbuild plugin that leaves the shared modules out of the bundle. The `external` option is
 * not enough: svelte-gpui's build aliases its own name to the runtime's files before the option
 * is looked at, which would bundle a second copy of the runtime into the script.
 */
const sharedModules = {
  name: "shared-modules",
  setup(build) {
    const names = SHARED.filter((name) => !name.endsWith("*"));
    build.onResolve({ filter: /^(svelte|@neoworks\/svelte-gpui|@neoworks\/extension-system|@grove\/extension)(\/|$)/ }, (args) => {
      if (names.includes(args.path) || args.path.startsWith("svelte/")) {
        return { path: args.path, external: true };
      }
      return null;
    });
  },
};

/** Builds each plugin of the extension in `directory` that has a `source`. */
export async function buildExtension(directory) {
  const root = resolve(directory);
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const plugins = packageJson.grove?.plugins ?? [];
  for (const plugin of plugins) {
    if (typeof plugin.source !== "string") {
      continue;
    }
    await build({
      entry: join(root, plugin.source),
      outfile: join(root, plugin.main),
      external: SHARED,
      plugins: [sharedModules],
    });
  }
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) {
    console.error("usage: bun scripts/buildExtension.mjs path/to/extension");
    process.exit(2);
  }
  await buildExtension(directory);
}
