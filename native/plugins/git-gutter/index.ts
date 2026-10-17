// The git-gutter plugin: shows how an open file differs from HEAD as bars in the gutter, and who
// last changed the cursor's line as text after it. It is the first source of decorations for the
// editor, and the other sources (language servers, agents) put theirs on the same way.

import type { Context } from "@neoworks/extension-system";
import { gpuiGitHost } from "./gitHost";
import { GitGutterService } from "./service";

export const gitGutter = {
  name: "git-gutter",
  inject: ["editor"],
  apply(ctx: Context) {
    new GitGutterService(ctx, ctx.editor, gpuiGitHost());
  },
};
