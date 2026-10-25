<!--
  What the review comments of a worktree come to, and the button that sends them to the agent: the
  number of comments and "Send to agent", or after a send, an offer to take it back. Drawn in the
  strip over a diff in an editor and in the agent's Files panel; it draws nothing while there is
  nothing to say.
-->
<script lang="ts">
  import { Button, Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import paperPlane from "@phosphor-icons/core/regular/paper-plane-tilt.svg";
  import { colors, fontSize, radius } from "../theme/tokens";
  import { commentCount } from "./model";
  import type { ReviewCommentsService } from "./service";

  interface Props {
    review: ReviewCommentsService;
    /** The file the strip is over; its worktree is the one to review. */
    path?: string;
    /** The worktree to review, when there is no file. */
    worktreePath?: string | null;
  }

  let { review, path, worktreePath }: Props = $props();

  const root = $derived.by(() => {
    if (worktreePath !== undefined && worktreePath !== null) {
      return worktreePath;
    }
    if (path === undefined) {
      return null;
    }
    return review.worktreeOf(path);
  });
  const count = $derived.by(() => {
    if (root === null) {
      return 0;
    }
    return review.commentsIn(root).length;
  });
  const sent = $derived(review.lastSent());
  const undoable = $derived(sent !== null && sent.worktreePath === root);

  /** The look of a text button. */
  const textButton = { height: 24, paddingX: 6, gap: 4, align: "center", radius: radius.sm, fontSize: fontSize.xxs } as const;

  /** Sends the worktree's comments to the agent. */
  function send(): void {
    if (root !== null) {
      void review.send(root);
    }
  }
</script>

{#if count > 0}
  <View style={{ direction: "row", align: "center", gap: 6, shrink: 0 }}>
    <Text style={{ fontSize: fontSize.xxs, color: colors.muted }}>{commentCount(count)}</Text>
    <Button style={{ ...textButton, color: colors.inverse, background: colors.primary }} hover={{ opacity: 0.85 }} onpress={send}>
      <Icon svg={paperPlane} size={12} />
      <Text>Send to agent</Text>
    </Button>
  </View>
{:else if undoable && sent !== null}
  <View style={{ direction: "row", align: "center", gap: 6, shrink: 0 }}>
    <Text style={{ fontSize: fontSize.xxs, color: colors.muted }}>Sent {commentCount(sent.count)}</Text>
    <Button style={{ ...textButton, color: colors.dim }} hover={{ background: colors.hover, color: colors.text }} onpress={() => void review.undoSend()}>
      <Text>Undo</Text>
    </Button>
  </View>
{/if}
