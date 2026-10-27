<!--
  The Git changes view: a box for the commit message over the files git reports as changed,
  staged ones first. Pressing a file opens its diff; a row offers to stage, unstage or discard
  its file, and each section does the same for all of its files. Discarding is confirmed in a
  bar over the list, since it cannot be undone.
-->
<script lang="ts">
  import { Button, Icon, Input, Text, View, type TreeRow } from "@neoworks/svelte-gpui/ui";
  import arrowClockwise from "@phosphor-icons/core/regular/arrow-clockwise.svg";
  import arrowCounterClockwise from "@phosphor-icons/core/regular/arrow-counter-clockwise.svg";
  import check from "@phosphor-icons/core/regular/check.svg";
  import minus from "@phosphor-icons/core/regular/minus.svg";
  import plus from "@phosphor-icons/core/regular/plus.svg";
  import { untrack } from "svelte";
  import ChangeTree from "../explorer/ChangeTree.svelte";
  import type { ChangeTreeNode } from "../explorer/changeTree";
  import type { FileIconSource } from "../explorer/fileIcons";
  import type { SidecarService } from "../sidecar/service";
  import { colors, fontSize, radius } from "../theme/tokens";
  import type { WorkspaceService } from "../workspace/service";
  import { commitHint, sectionsOf, STAGED_SECTION, type ChangeEntry } from "./model";
  import type { GitChangesService } from "./service";

  interface Props {
    changes: GitChangesService;
    /** Where the tree takes its file icons from. */
    icons: FileIconSource;
    workspace: WorkspaceService;
    sidecar: SidecarService;
  }

  let { changes, icons, workspace, sidecar }: Props = $props();


  const running = $derived(sidecar.isRunning());
  const worktree = $derived(workspace.selectedWorktree());
  const groups = $derived(changes.files());
  const sections = $derived(sectionsOf(groups));
  const pending = $derived(changes.pending());
  const notice = $derived(changes.notice());
  const canCommit = $derived(changes.canCommit());
  const openedKey = $derived(changes.openedKey());
  /** The tree's highlighted row: the file whose diff is open, if any. */
  const selectedKey = $derived.by(() => {
    if (openedKey === null) {
      return undefined;
    }
    return openedKey;
  });
  const branch = $derived(workspace.branch() === null ? "this branch" : (workspace.branch() as string));

  let text = $state("");

  // The files are read when the view appears with a worktree shown, and again when another is.
  $effect(() => {
    if (running && worktree !== null) {
      untrack(() => void changes.refresh());
    }
  });

  // The message box follows the service, which clears it after a commit.
  $effect(() => {
    const written = changes.message();
    untrack(() => {
      if (written !== text) {
        text = written;
      }
    });
  });

  /** Commits on Ctrl+Enter, as the Electron app does. */
  function messageKey(event: { key: string; ctrl: boolean; preventDefault(): void }): void {
    if (event.key === "Enter" && event.ctrl) {
      event.preventDefault();
      void changes.commit();
    }
  }

  /** The files a discard confirmation names, as a sentence. */
  function discardSentence(entries: ChangeEntry[]): string {
    if (entries.length === 1) {
      return `The changes to ${entries[0].name} will be thrown away.`;
    }
    return `The changes to ${entries.length} files will be thrown away.`;
  }

  const ROW_HEIGHT = 26;

  /** A file's row was pressed: its diff opens. */
  function openFile(node: ChangeTreeNode<ChangeEntry>): void {
    if (node.item !== undefined) {
      void changes.open(node.item);
    }
  }

  const buttonStyle = { size: 22, align: "center", justify: "center", radius: radius.sm, shrink: 0 } as const;
</script>

<View style={{ flex: 1, minHeight: 0 }}>
  {#if !running}
    <View style={{ padding: 12 }}>
      <Text style={{ fontSize: fontSize.xs, color: colors.muted }}>The sidecar is not running, so changes can't be read.</Text>
    </View>
  {:else if worktree === null}
    <View style={{ padding: 12 }}>
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Open a folder to see its changes.</Text>
    </View>
  {:else}
    <View style={{ gap: 6, paddingX: 10, paddingTop: 8, paddingBottom: 8, shrink: 0 }}>
      <Input
        bind:value={text}
        multiline
        rows={3}
        placeholder="Message (Ctrl+Enter to commit)"
        oninput={(value: string) => changes.setMessage(value)}
        onkey={messageKey}
        style={{ paddingX: 8, paddingY: 6, radius: radius.sm, background: colors.input, borderWidth: 1, borderColor: colors.line, fontSize: fontSize.xs }}
        focus={{ borderColor: colors.accent }}
      />
      <Button
        style={{
          height: 26,
          gap: 6,
          align: "center",
          justify: "center",
          radius: radius.sm,
          fontSize: fontSize.xs,
          background: canCommit ? colors.primary : colors.raised,
          color: canCommit ? colors.primaryFg : colors.dim,
        }}
        onpress={() => void changes.commit()}
      >
        <Icon svg={check} size={13} />
        <Text style={{ truncate: true, minWidth: 0 }}>{canCommit ? `Commit to ${branch}` : commitHint(groups.staged.length, text, branch)}</Text>
      </Button>
    </View>

    {#if pending !== null}
      <View style={{ gap: 6, paddingX: 12, paddingBottom: 8 }}>
        <Text style={{ fontSize: fontSize.xs, color: colors.text }}>{discardSentence(pending.entries)}</Text>
        <Text style={{ fontSize: fontSize.xxs, color: colors.dim }}>This can't be undone.</Text>
        <View style={{ direction: "row", gap: 6 }}>
          <Button
            style={{ paddingX: 10, height: 24, radius: radius.sm, background: colors.redSoft, color: colors.red, fontSize: fontSize.xs }}
            onpress={() => void changes.confirmDiscard()}
          >
            <Text>Discard</Text>
          </Button>
          <Button
            style={{ paddingX: 10, height: 24, radius: radius.sm, color: colors.muted, fontSize: fontSize.xs }}
            hover={{ background: colors.hover }}
            onpress={() => changes.cancelDiscard()}
          >
            <Text>Cancel</Text>
          </Button>
        </View>
      </View>
    {/if}

    {#if notice !== ""}
      <View style={{ direction: "row", gap: 6, paddingX: 12, paddingBottom: 8 }}>
        <Text style={{ flex: 1, minWidth: 0, fontSize: fontSize.xxs, color: colors.red }}>{notice}</Text>
        <Button style={{ color: colors.dim }} onpress={() => changes.clearNotice()}><Text>Dismiss</Text></Button>
      </View>
    {/if}

    {#if sections.length === 0}
      <View style={{ padding: 12, gap: 6 }}>
        <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>No changes in this worktree.</Text>
        <Button
          style={{ ...buttonStyle, width: 22, color: colors.dim }}
          hover={{ background: colors.hover, color: colors.text }}
          onpress={() => void changes.refresh()}
        >
          <Icon svg={arrowClockwise} size={13} />
        </Button>
      </View>
    {:else}
      <ChangeTree roots={sections} iconSet={icons.iconSet()} rowHeight={ROW_HEIGHT} selected={selectedKey} onopen={openFile}>
        {#snippet header(node: ChangeTreeNode<ChangeEntry>, info: TreeRow)}
          {@const entries = node.key === STAGED_SECTION ? groups.staged : groups.unstaged}
          <View style={{ direction: "row", align: "center", gap: 2, minWidth: 0, height: ROW_HEIGHT }} onpress={() => info.toggle()}>
            <Text style={{ flex: 1, minWidth: 0, truncate: true, fontSize: fontSize.xxs, color: colors.dim, uppercase: true }}>{node.name}</Text>
            {#if node.key === STAGED_SECTION}
              <Button style={{ ...buttonStyle, color: colors.dim }} hover={{ background: colors.hover, color: colors.text }} onpress={() => void changes.unstageAll()}>
                <Icon svg={minus} size={13} />
              </Button>
            {:else}
              <Button style={{ ...buttonStyle, color: colors.dim }} hover={{ background: colors.redSoft, color: colors.red }} onpress={() => changes.beginDiscard(entries)}>
                <Icon svg={arrowCounterClockwise} size={13} />
              </Button>
              <Button style={{ ...buttonStyle, color: colors.dim }} hover={{ background: colors.hover, color: colors.text }} onpress={() => void changes.stageAll()}>
                <Icon svg={plus} size={13} />
              </Button>
            {/if}
          </View>
        {/snippet}
        {#snippet trailing(node: ChangeTreeNode<ChangeEntry>, hovered: boolean)}
          {#if hovered && node.item !== undefined}
            {@const entry = node.item}
            {#if !entry.staged}
              <Button style={{ ...buttonStyle, color: colors.dim }} hover={{ background: colors.redSoft, color: colors.red }} onpress={() => changes.beginDiscard([entry])}>
                <Icon svg={arrowCounterClockwise} size={13} />
              </Button>
              <Button style={{ ...buttonStyle, color: colors.dim }} hover={{ background: colors.hover, color: colors.text }} onpress={() => void changes.stage([entry])}>
                <Icon svg={plus} size={13} />
              </Button>
            {:else}
              <Button style={{ ...buttonStyle, color: colors.dim }} hover={{ background: colors.hover, color: colors.text }} onpress={() => void changes.unstage([entry])}>
                <Icon svg={minus} size={13} />
              </Button>
            {/if}
          {/if}
        {/snippet}
      </ChangeTree>
    {/if}
  {/if}
</View>
