<!-- The checked out branch of the shown worktree in the status bar, and why the last open failed. -->
<script lang="ts">
  import { Icon, Text, View } from "@neoworks/svelte-gpui/ui";
  import gitBranch from "@phosphor-icons/core/regular/git-branch.svg";
  import { colors } from "../theme/tokens";
  import type { WorkspaceService } from "./service";

  let { workspace }: { workspace: WorkspaceService } = $props();

  const branch = $derived(workspace.branch());
  const error = $derived(workspace.error());
</script>

{#if branch}
  <View style={{ direction: "row", align: "center", gap: 4 }}>
    <Icon svg={gitBranch} size={12} />
    <Text>{branch}</Text>
  </View>
{/if}
{#if error}
  <Text style={{ color: colors.red, maxWidth: 360, truncate: true }}>{error}</Text>
{/if}
