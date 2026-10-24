<!--
  An item's state as a filled pill: green for open, red for closed, accent for merged, and quiet
  for a draft.
-->
<script lang="ts">
  import { Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import gitMerge from "@phosphor-icons/core/regular/git-merge.svg";
  import gitPullRequest from "@phosphor-icons/core/regular/git-pull-request.svg";
  import circleDashed from "@phosphor-icons/core/regular/circle-dashed.svg";
  import checkCircle from "@phosphor-icons/core/regular/check-circle.svg";
  import radioButton from "@phosphor-icons/core/regular/radio-button.svg";
  import { colors, fontSize } from "../theme/tokens";
  import type { ItemKind, ItemState } from "./model";
  import { stateWord } from "./present";

  interface Props {
    state: ItemState;
    kind: ItemKind;
  }

  let { state, kind }: Props = $props();

  const background = $derived.by(() => {
    if (state === "open") {
      return colors.green;
    }
    if (state === "closed") {
      return colors.red;
    }
    if (state === "merged") {
      return colors.accent;
    }
    return colors.raised;
  });
  const foreground = $derived.by(() => {
    if (state === "draft") {
      return colors.muted;
    }
    return colors.inverse;
  });
  const icon = $derived.by(() => {
    if (state === "merged") {
      return gitMerge;
    }
    if (state === "draft") {
      return circleDashed;
    }
    if (kind === "pull") {
      return gitPullRequest;
    }
    if (state === "closed") {
      return checkCircle;
    }
    return radioButton;
  });
</script>

<View style={{ direction: "row", align: "center", gap: 4, shrink: 0, height: 22, paddingX: 8, radius: 11, background, color: foreground }}>
  <Icon svg={icon} size={13} />
  <Text style={{ fontSize: fontSize.xs, fontWeight: "bold" }}>{stateWord(state)}</Text>
</View>
