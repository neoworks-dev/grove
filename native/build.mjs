// Bundles the native app's Svelte side into one script for the host to run.
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "@neoworks/svelte-gpui/build";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

await build({
  entry: here("./ui/main.ts"),
  outfile: here("./dist/grove-native.js"),
});

// Images the app shows by path are resolved against the bundle's directory.
await mkdir(here("./dist/assets"), { recursive: true });
await cp(here("./assets"), here("./dist/assets"), { recursive: true });
