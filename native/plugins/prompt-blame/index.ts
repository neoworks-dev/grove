// The prompt-blame plugin: the `promptBlame` service, which shows the prompt behind the cursor's
// line when an agent wrote it. It reads Grove's prompt records through the sidecar.

import type { Context } from "@neoworks/extension-system";
import { sidecarBlameHost } from "./blameHost";
import { PromptBlameService } from "./service";

export const promptBlame = {
  name: "prompt-blame",
  inject: ["editor", "sidecar", "workspace"],
  apply(ctx: Context) {
    new PromptBlameService(ctx, ctx.editor, sidecarBlameHost(ctx.sidecar), ctx.workspace);
  },
};
