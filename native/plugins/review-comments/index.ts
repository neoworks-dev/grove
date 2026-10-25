// The review-comments plugin: comments on changed lines of the diff drawn over a file, added from
// the gutter's "+", a key or the editor's context menu, kept per worktree across restarts and sent
// to the agent as one message from the strip over the diff or the agent's Files panel.

import type { Context } from "@neoworks/extension-system";
import CommentLayer from "./CommentLayer.svelte";
import { hostReviewFiles } from "./hostFiles";
import ReviewBar from "./ReviewBar.svelte";
import { registerReviewCommands } from "./commands";
import { ReviewCommentsService, type ReviewSender } from "./service";
import { CommentStore } from "./store";

export const reviewComments = {
  name: "review-comments",
  inject: ["slots", "commands", "keymap", "menus", "editor", "diff", "layout", "workspace", "agents"],
  apply(ctx: Context) {
    const service = new ReviewCommentsService(
      ctx,
      ctx.editor,
      ctx.diff,
      ctx.layout,
      { paths: () => ctx.workspace.worktrees().map((worktree: { path: string }) => worktree.path) },
      agentSender(ctx),
      new CommentStore(hostReviewFiles),
    );
    ctx.slots.register("editor.overlay", { id: "review.comments", component: CommentLayer, props: { review: service, editor: ctx.editor } });
    ctx.slots.register("diff.inline.actions", { id: "review.bar", order: 10, component: ReviewBar, props: { review: service } });
    ctx.slots.register("agents.files.review", { id: "review.bar", order: 10, component: ReviewBar, props: { review: service } });
    registerReviewCommands(ctx, service);
  },
};

/** Sends reviews to the agents plugin's sessions. */
function agentSender(ctx: Context): ReviewSender {
  return {
    sessionFor: (worktreePath, absolutePaths) => ctx.agents.reviewSessionFor(worktreePath, absolutePaths),
    send: (sessionId, text, shown) => ctx.agents.sendReview(sessionId, text, shown),
  };
}
