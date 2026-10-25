// What the review comments add to the command palette, the keymap and the editor's context menu.
// Kept apart from `index.ts`, which imports the components, so it runs under `bun test`.

import type { Context } from "@neoworks/extension-system";
import { KeyPriority } from "../../kernel/keymap";
import type { ReviewCommentsService } from "./service";

/** Registers the commands, their keys and the context menu entry. */
export function registerReviewCommands(ctx: Context, service: ReviewCommentsService): void {
  ctx.commands.register({
    id: "review.addComment",
    title: "Review: comment on this line",
    group: "Git",
    keywords: "review comment note feedback agent diff",
    when: () => service.canComment(),
    run: () => service.beginAtSelection(),
  });
  ctx.commands.register({
    id: "review.send",
    title: "Review: send the comments to the agent",
    group: "Git",
    keywords: "review comments agent feedback",
    when: () => service.countForFocused() > 0,
    run: async () => {
      const worktreePath = service.focusedWorktree();
      if (worktreePath !== null) {
        await service.send(worktreePath);
      }
    },
  });
  ctx.keymap.bind([
    { id: "review.addComment", keys: "ctrl+alt+c", command: "review.addComment", group: "Git", description: "Comment on this line" },
    { id: "review.addComment.leader", keys: "leader g c", command: "review.addComment", group: "Git", description: "Comment on this line" },
    { id: "review.send", keys: "leader g s", command: "review.send", group: "Git", description: "Send comments to the agent" },
  ]);
  // The input types into its own field, so the bindings stand down while it is open.
  ctx.keymap.subscribe(KeyPriority.overlay, () => service.isDrafting());
  ctx.menus.registerItems([
    {
      id: "editor.context.review.addComment",
      menuId: "editor.context",
      label: "Comment on This Line",
      group: "3-git",
      order: 5,
      commandId: "review.addComment",
      when: () => service.canComment(),
    },
  ]);
}
