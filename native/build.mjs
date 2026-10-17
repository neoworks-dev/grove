// Bundles the native app's Svelte side into one script for the host to run.
import { fileURLToPath } from "node:url";
import { build } from "@neoworks/svelte-gpui/build";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

await build({
  entry: here("./ui/main.ts"),
  outfile: here("./dist/grove-native.js"),
});
