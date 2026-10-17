<!--
  The worktrees view: every worktree of the open repository with its branch, how far the branch
  is from the base and how many lines it changes. Pressing a row shows that worktree, in the
  explorer and everywhere else that follows the workspace. A new worktree is asked for by name
  in a bar over the list, and removing one is confirmed there.
-->
<script lang="ts">
  import { Button, Icon, Input, List, Text, View } from "@neoworks/svelte-gpui/ui";
  import plus from "@phosphor-icons/core/regular/plus.svg";
  import trash from "@phosphor-icons/core/regular/trash.svg";
  import arrowClockwise from "@phosphor-icons/core/regular/arrow-clockwise.svg";
  import { untrack } from "svelte";
  import { colors, fontSize, radius } from "../theme/tokens";
  import type { SidecarService } from "../sidecar/service";
  import type { WorkspaceService } from "../workspace/service";
  import type { WorktreesService } from "./service";
  import type { Worktree } from "../../../src/shared/types";

  interface Props {
    worktrees: WorktreesService;
    workspace: WorkspaceService;
    sidecar: SidecarService;
  }

  let { worktrees, workspace, sidecar }: Props = $props();

  const list = $derived(workspace.worktrees());
  const selected = $derived(workspace.selectedWorktree());
  const running = $derived(sidecar.isRunning());
  const pending = $derived(worktrees.pending());
  const notice = $derived(worktrees.notice());

  let name = $state("");
  /** The worktree under the pointer, whose row offers to remove it. */
  let hoveredId = $state<string | null>(null);
  let nameInput = $state<ReturnType<typeof Input> | undefined>();

  // The list is read again whenever the view appears with a repository open.
  $effect(() => {
    if (running && workspace.repo() !== null) {
      untrack(() => void worktrees.refresh());
    }
  });

  // The name field starts empty and has the keyboard when a create is asked for.
  $effect(() => {
    if (pending !== null && pending.kind === "create") {
      name = "";
      nameInput?.focus();
    }
  });

  /** Creates the worktree with the typed name. */
  function submitName(): void {
    void worktrees.commitCreate(name);
  }

  /** Tracks which row the pointer is on. */
  function trackHover(worktree: Worktree, hovered: boolean): void {
    if (hovered) {
      hoveredId = worktree.id;
      return;
    }
    if (hoveredId === worktree.id) {
      hoveredId = null;
    }
  }

  /** The text for how far a branch is from its base: "↑2 ↓1", or an empty string when level. */
  function positionText(worktree: Worktree): string {
    const position = worktrees.positionOf(worktree.id);
    if (position === undefined) {
      return "";
    }
    const parts: string[] = [];
    if (position.ahead > 0) {
      parts.push(`↑${position.ahead}`);
    }
    if (position.behind > 0) {
      parts.push(`↓${position.behind}`);
    }
    return parts.join(" ");
  }
</script>

<View style={{ flex: 1, minHeight: 0 }}>
  {#if !running}
    <View style={{ padding: 12, gap: 4 }}>
      <Text style={{ fontSize: fontSize.xs, color: colors.muted }}>The sidecar is not running, so worktrees can't be listed.</Text>
    </View>
  {:else if workspace.repo() === null}
    <View style={{ padding: 12 }}>
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Open a folder to see its worktrees.</Text>
    </View>
  {:else}
    <View style={{ direction: "row", align: "center", gap: 2, height: 28, shrink: 0, paddingLeft: 12, paddingRight: 6 }}>
      <Text style={{ flex: 1, minWidth: 0, truncate: true, fontSize: fontSize.xxs, color: colors.dim, uppercase: true }}>
        {list.length} worktrees
      </Text>
      <Button
        style={{ size: 22, align: "center", justify: "center", radius: radius.sm, color: colors.dim }}
        hover={{ background: colors.hover, color: colors.text }}
        onpress={() => void worktrees.refresh()}
      >
        <Icon svg={arrowClockwise} size={13} />
      </Button>
      <Button
        style={{ height: 22, paddingX: 6, gap: 4, align: "center", radius: radius.sm, color: colors.dim, fontSize: fontSize.xxs }}
        hover={{ background: colors.hover, color: colors.text }}
        onpress={() => worktrees.beginCreate()}
      >
        <Icon svg={plus} size={12} />
        <Text>New</Text>
      </Button>
    </View>

    {#if pending !== null && pending.kind === "create"}
      <View style={{ gap: 6, paddingX: 12, paddingBottom: 8 }}>
        <Text style={{ fontSize: fontSize.xxs, color: colors.muted }}>New worktree and branch</Text>
        <Input
          bind:this={nameInput}
          bind:value={name}
          placeholder="feature-x"
          onsubmit={submitName}
          onkey={(event) => {
            if (event.key === "Escape") {
              worktrees.cancelPending();
            }
          }}
          style={{ height: 26, paddingX: 8, radius: radius.sm, background: colors.input, borderWidth: 1, borderColor: colors.line, fontSize: fontSize.xs }}
          focus={{ borderColor: colors.accent }}
        />
      </View>
    {:else if pending !== null && pending.worktree !== undefined}
      <View style={{ gap: 6, paddingX: 12, paddingBottom: 8 }}>
        <Text style={{ fontSize: fontSize.xs, color: colors.text }}>The worktree {pending.worktree.name} will be removed.</Text>
        <Text style={{ fontSize: fontSize.xxs, color: colors.dim }}>
          Its directory goes; the branch {pending.worktree.branch} stays.{pending.worktree.dirty ? " Its uncommitted changes are lost." : ""}
        </Text>
        <View style={{ direction: "row", gap: 6 }}>
          <Button
            style={{ paddingX: 10, height: 24, radius: radius.sm, background: colors.redSoft, color: colors.red, fontSize: fontSize.xs }}
            onpress={() => void worktrees.confirmRemove()}
          >
            <Text>Remove</Text>
          </Button>
          <Button
            style={{ paddingX: 10, height: 24, radius: radius.sm, color: colors.muted, fontSize: fontSize.xs }}
            hover={{ background: colors.hover }}
            onpress={() => worktrees.cancelPending()}
          >
            <Text>Cancel</Text>
          </Button>
        </View>
      </View>
    {/if}

    {#if notice !== null}
      <View style={{ direction: "row", gap: 6, paddingX: 12, paddingBottom: 8 }}>
        <Text style={{ flex: 1, minWidth: 0, fontSize: fontSize.xxs, color: colors.red }}>{notice}</Text>
        <Button style={{ color: colors.dim }} onpress={() => worktrees.clearNotice()}><Text>Dismiss</Text></Button>
      </View>
    {/if}

    <List items={list} rowHeight={44} key={(worktree) => worktree.id} style={{ flex: 1 }}>
      {#snippet row(worktree)}
        {@const stats = worktrees.statsOf(worktree.id)}
        {@const position = positionText(worktree)}
        <View
          style={{
            direction: "row",
            align: "center",
            gap: 8,
            height: 44,
            paddingX: 12,
            background: selected !== null && selected.id === worktree.id ? colors.elevated : "transparent",
          }}
          hover={{ background: colors.hover }}
          onhover={(hovered: boolean) => trackHover(worktree, hovered)}
          onpress={() => void workspace.selectWorktree(worktree.id)}
        >
          <View style={{ size: 8, radius: 4, shrink: 0, background: worktree.dirty ? colors.amber : colors.green }} />
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <View style={{ direction: "row", align: "center", gap: 6 }}>
              <Text style={{ truncate: true, minWidth: 0, fontSize: fontSize.sm, color: colors.text }}>{worktree.name}</Text>
              {#if worktree.isMain}
                <Text style={{ paddingX: 4, radius: radius.sm, background: colors.raised, fontSize: fontSize.xxs, color: colors.dim }}>main</Text>
              {/if}
            </View>
            <View style={{ direction: "row", align: "center", gap: 6 }}>
              <Text style={{ truncate: true, minWidth: 0, fontFamily: "mono", fontSize: fontSize.xxs, color: colors.dim }}>{worktree.branch}</Text>
              {#if position !== ""}
                <Text style={{ shrink: 0, fontFamily: "mono", fontSize: fontSize.xxs, color: colors.dim }}>{position}</Text>
              {/if}
            </View>
          </View>
          {#if stats !== undefined && (stats.added > 0 || stats.removed > 0)}
            <View style={{ direction: "row", gap: 4, shrink: 0 }}>
              <Text style={{ fontFamily: "mono", fontSize: fontSize.xxs, color: colors.green }}>+{stats.added}</Text>
              <Text style={{ fontFamily: "mono", fontSize: fontSize.xxs, color: colors.red }}>−{stats.removed}</Text>
            </View>
          {/if}
          {#if !worktree.isMain && hoveredId === worktree.id}
            <Button
              style={{ height: 22, paddingX: 6, gap: 4, shrink: 0, align: "center", radius: radius.sm, color: colors.dim, fontSize: fontSize.xxs }}
              hover={{ background: colors.redSoft, color: colors.red }}
              onpress={() => worktrees.beginRemove(worktree)}
            >
              <Icon svg={trash} size={12} />
              <Text>Remove</Text>
            </Button>
          {/if}
        </View>
      {/snippet}
    </List>
  {/if}
</View>
