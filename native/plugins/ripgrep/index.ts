// The ripgrep plugin: the `ripgrep` service the file picker and the content search use.

import type { Context } from "@neoworks/extension-system";
import { runOnHost } from "./host";
import { RipgrepService } from "./service";

export const ripgrep = {
  name: "ripgrep",
  inject: ["workspace"],
  apply(ctx: Context) {
    new RipgrepService(ctx, runOnHost);
  },
};
