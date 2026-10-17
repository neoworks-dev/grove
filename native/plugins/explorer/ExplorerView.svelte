<!--
  The explorer: the shown worktree's files as a tree. A folder is listed when it is first
  expanded, files git has changed are coloured and lettered, and the tree follows the watcher.
  A press opens a file or opens and closes a folder, a right press opens the menu, and with
  the tree focused F2 renames, Delete deletes, and `a` and `A` make a file and a folder. Names
  and confirmations are asked for in a bar over the tree.
-->
<script lang="ts">
  import { clipboard } from "@neoworks/svelte-gpui";
  import { Button, ContextMenu, Icon, Input, Text, Tree, View, type MenuItem, type PointerEvent, type TreeRow } from "@neoworks/svelte-gpui/ui";
  import arrowClockwise from "@phosphor-icons/core/regular/arrow-clockwise.svg";
  import arrowsInLineVertical from "@phosphor-icons/core/regular/arrows-in-line-vertical.svg";
  import file from "@phosphor-icons/core/regular/file.svg";
  import filePlus from "@phosphor-icons/core/regular/file-plus.svg";
  import folder from "@phosphor-icons/core/regular/folder.svg";
  import folderOpen from "@phosphor-icons/core/regular/folder-open.svg";
  import folderPlus from "@phosphor-icons/core/regular/folder-plus.svg";
  import { tick, untrack } from "svelte";
  import { useKernel } from "../../kernel/kernel";
  import type { SidecarService } from "../sidecar/service";
  import { colors, fontSize, radius } from "../theme/tokens";
  import type { WorkspaceService } from "../workspace/service";
  import type { DiffChangeType, FileNode } from "../../../src/shared/types";
  import { ancestorsOf, parentOf } from "./model";
  import type { ExplorerService } from "./service";

  interface Props {
    explorer: ExplorerService;
    workspace: WorkspaceService;
    sidecar: SidecarService;
  }

  let { explorer, workspace, sidecar }: Props = $props();

  const kernel = useKernel();

  const worktree = $derived(workspace.selectedWorktree());
  const worktreeId = $derived(worktree === null ? null : worktree.id);
  const running = $derived(sidecar.isRunning());
  const status = $derived(explorer.status());
  const pending = $derived(explorer.pending());
  const notice = $derived(explorer.notice());

  let expanded = $state<Set<string | number>>(new Set());
  let selected = $state<string | number | undefined>();
  let tree = $state<{ reveal(key: string | number): void } | undefined>();
  let menu = $state<{ openAt(x: number, y: number, items?: MenuItem[]): void } | undefined>();
  let nameInput = $state<ReturnType<typeof Input> | undefined>();
  let name = $state("");

  /** The colour a git change gives a file's name and its letter. Derived so it follows a theme switch. */
  const changeColors: Record<DiffChangeType, string> = $derived({
    added: colors.green,
    modified: colors.amber,
    deleted: colors.red,
    renamed: colors.blue,
    untracked: colors.accent,
  });

  const changeLetters: Record<DiffChangeType, string> = {
    added: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
    untracked: "U",
  };

  // Another worktree starts a fresh tree; the same one, shown again, reads again.
  $effect(() => {
    const showing = worktreeId;
    if (!running || showing === null) {
      return;
    }
    untrack(() => {
      expanded = new Set();
      selected = undefined;
      void explorer.show(showing);
    });
  });

  // A name field starts with the name being edited and has the keyboard.
  $effect(() => {
    if (pending === null || pending.kind === "delete") {
      return;
    }
    name = pending.initialName;
    nameInput?.focus();
  });

  const markedDirectories = $derived(explorer.markedDirectories(expanded));

  /** The colour of an entry's name: its change, or a folder's tint when something below it changed. */
  function nameColor(node: FileNode): string {
    if (node.isDir) {
      if (markedDirectories.has(node.relPath)) {
        return colors.amber;
      }
      return colors.muted;
    }
    const change = explorer.changeOf(node.relPath);
    if (change === undefined) {
      return colors.muted;
    }
    return changeColors[change];
  }

  /** The directory a new entry goes in when made from this entry, opening the entry when it is a folder. */
  function creationDirectory(node: FileNode | undefined): string {
    if (node === undefined) {
      return "";
    }
    if (!node.isDir) {
      return parentOf(node.relPath);
    }
    showDirectory(node.relPath);
    return node.relPath;
  }

  /** Expands a directory, listing it first when it has not been listed. */
  function showDirectory(relPath: string): void {
    expanded = new Set([...expanded, relPath]);
    void explorer.ensureLoaded(relPath);
  }

  /** The entry the tree has selected. */
  function selectedNode(): FileNode | undefined {
    if (selected === undefined) {
      return undefined;
    }
    return explorer.nodeAt(String(selected));
  }

  /** A press on a row: opens a file in the editor, opens or closes a folder. */
  function pressRow(event: PointerEvent, node: FileNode, row: TreeRow): void {
    if (event.button !== 0) {
      return;
    }
    row.select();
    if (node.isDir) {
      row.toggle();
      return;
    }
    explorer.openFile(node);
  }

  /** A right press on a row: selects it and opens the menu there. */
  function openMenu(event: PointerEvent, node: FileNode, row: TreeRow): void {
    row.select();
    menu?.openAt(event.windowX, event.windowY, menuItemsFor(node));
  }

  /** What the menu offers for an entry. */
  function menuItemsFor(node: FileNode): MenuItem[] {
    return [
      { label: "New File", icon: filePlus, onselect: () => explorer.beginCreate("create-file", creationDirectory(node)) },
      { label: "New Folder", icon: folderPlus, onselect: () => explorer.beginCreate("create-directory", creationDirectory(node)) },
      { separator: true },
      { label: "Rename", shortcut: "F2", onselect: () => explorer.beginRename(node) },
      { label: "Delete", shortcut: "Del", danger: true, onselect: () => explorer.beginDelete(node) },
      { separator: true },
      { label: "Copy Path", onselect: () => void clipboard.write(node.path) },
      { label: "Copy Relative Path", onselect: () => void clipboard.write(node.relPath) },
      { label: "Reveal in File Manager", onselect: () => void revealInFileManager(node) },
    ];
  }

  /** Has the system open the folder an entry is in. */
  async function revealInFileManager(node: FileNode): Promise<void> {
    let directory = node.path;
    if (!node.isDir) {
      directory = node.path.slice(0, node.path.lastIndexOf("/"));
    }
    try {
      await sidecar.workbench.openExternal(`file://${directory}`);
    } catch (error) {
      kernel.reportError("explorer", error);
    }
  }

  /** Keys the tree leaves alone: the edits, on the selected entry. */
  function onKey(event: { key: string; ctrl: boolean; alt: boolean; meta: boolean; stopPropagation(): void }): void {
    if (event.ctrl || event.alt || event.meta || pending !== null) {
      return;
    }
    const node = selectedNode();
    if (event.key === "a") {
      explorer.beginCreate("create-file", creationDirectory(node));
    } else if (event.key === "A") {
      explorer.beginCreate("create-directory", creationDirectory(node));
    } else if (node !== undefined && event.key === "F2") {
      explorer.beginRename(node);
    } else if (node !== undefined && event.key === "Delete") {
      explorer.beginDelete(node);
    } else {
      return;
    }
    event.stopPropagation();
  }

  /** Carries out the waiting edit with the typed name, and shows what it made. */
  async function commit(): Promise<void> {
    const made = await explorer.commitPending(name);
    if (made === null) {
      return;
    }
    for (const ancestor of ancestorsOf(made)) {
      showDirectory(ancestor);
    }
    selected = made;
    await tick();
    tree?.reveal(made);
  }

  /** The buttons over the tree. */
  const toolbarActions = [
    { icon: filePlus, run: () => explorer.beginCreate("create-file", creationDirectory(selectedNode())) },
    { icon: folderPlus, run: () => explorer.beginCreate("create-directory", creationDirectory(selectedNode())) },
    { icon: arrowClockwise, run: () => void explorer.refresh() },
    { icon: arrowsInLineVertical, run: () => (expanded = new Set()) },
  ];

  /** What the bar over the tree asks for, as a label. */
  function barLabel(kind: string, directory: string): string {
    if (kind === "rename") {
      return "Rename";
    }
    let what = "New file";
    if (kind === "create-directory") {
      what = "New folder";
    }
    if (directory === "") {
      return what;
    }
    return `${what} in ${directory}`;
  }
</script>

<View style={{ flex: 1, minHeight: 0 }}>
  {#if status === "sidecar-down"}
    <View style={{ padding: 12, gap: 4 }}>
      <Text style={{ fontSize: fontSize.xs, color: colors.muted }}>The sidecar is not running, so files can't be listed.</Text>
      <Text style={{ fontSize: fontSize.xxs, color: colors.dim }}>{sidecar.status().message}</Text>
    </View>
  {:else if status === "no-folder"}
    <View style={{ padding: 12, gap: 8, align: "start" }}>
      <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>No folder open.</Text>
      <Button
        style={{ paddingX: 10, height: 26, radius: radius.sm, borderWidth: 1, borderColor: colors.line, color: colors.text, fontSize: fontSize.xs }}
        hover={{ background: colors.hover }}
        onpress={() => void kernel.commands.run("workspace.openFolder")}
      >
        <Text>Open Folder…</Text>
      </Button>
    </View>
  {:else if status === "failed"}
    <View style={{ padding: 12, gap: 8, align: "start" }}>
      <Text style={{ fontSize: fontSize.xs, color: colors.red }}>{explorer.error()}</Text>
      <Button
        style={{ paddingX: 10, height: 26, radius: radius.sm, borderWidth: 1, borderColor: colors.line, color: colors.text, fontSize: fontSize.xs }}
        hover={{ background: colors.hover }}
        onpress={() => void explorer.refresh()}
      >
        <Text>Retry</Text>
      </Button>
    </View>
  {:else}
    <View style={{ direction: "row", align: "center", gap: 2, height: 28, shrink: 0, paddingLeft: 12, paddingRight: 6 }}>
      <Text style={{ flex: 1, minWidth: 0, truncate: true, fontSize: fontSize.xxs, color: colors.dim, uppercase: true }}>
        {#if worktree}{worktree.name}{/if}
      </Text>
      {#each toolbarActions as action}
        <Button
          style={{ size: 22, align: "center", justify: "center", radius: radius.sm, color: colors.dim }}
          hover={{ background: colors.hover, color: colors.text }}
          onpress={action.run}
        >
          <Icon svg={action.icon} size={13} />
        </Button>
      {/each}
    </View>

    {#if pending !== null && pending.kind === "delete"}
      <View style={{ gap: 6, paddingX: 12, paddingBottom: 8 }}>
        <Text style={{ fontSize: fontSize.xs, color: colors.text }}>{pending.target} will be deleted.</Text>
        <Text style={{ fontSize: fontSize.xxs, color: colors.dim }}>This cannot be undone.</Text>
        <View style={{ direction: "row", gap: 6 }}>
          <Button
            style={{ paddingX: 10, height: 24, radius: radius.sm, background: colors.redSoft, color: colors.red, fontSize: fontSize.xs }}
            onpress={() => void commit()}
          >
            <Text>Delete</Text>
          </Button>
          <Button
            style={{ paddingX: 10, height: 24, radius: radius.sm, color: colors.muted, fontSize: fontSize.xs }}
            hover={{ background: colors.hover }}
            onpress={() => explorer.cancelPending()}
          >
            <Text>Cancel</Text>
          </Button>
        </View>
      </View>
    {:else if pending !== null}
      <View style={{ gap: 6, paddingX: 12, paddingBottom: 8 }}>
        <Text style={{ fontSize: fontSize.xxs, color: colors.muted }}>{barLabel(pending.kind, pending.directory)}</Text>
        <Input
          bind:this={nameInput}
          bind:value={name}
          onsubmit={() => void commit()}
          onkey={(event) => {
            if (event.key === "Escape") {
              explorer.cancelPending();
            }
          }}
          style={{ height: 26, paddingX: 8, radius: radius.sm, background: colors.input, borderWidth: 1, borderColor: colors.line, fontSize: fontSize.xs }}
          focus={{ borderColor: colors.accent }}
        />
      </View>
    {/if}

    {#if notice !== null}
      <View style={{ direction: "row", gap: 6, paddingX: 12, paddingBottom: 8 }}>
        <Text style={{ flex: 1, minWidth: 0, fontSize: fontSize.xxs, color: colors.red }}>{notice}</Text>
        <Button style={{ color: colors.dim, fontSize: fontSize.xxs }} onpress={() => explorer.clearNotice()}><Text>Dismiss</Text></Button>
      </View>
    {/if}

    {#if status === "loading"}
      <View style={{ paddingX: 12 }}>
        <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>Loading…</Text>
      </View>
    {/if}

    <View style={{ flex: 1, minHeight: 0 }} onkey={onKey}>
      <Tree
        bind:this={tree}
        items={explorer.roots()}
        key={(node: FileNode) => node.relPath}
        childrenOf={(node: FileNode) => explorer.childrenOf(node)}
        isBranch={(node: FileNode) => node.isDir}
        bind:expanded
        bind:selected
        rowHeight={24}
        indent={12}
        onexpand={(node: FileNode) => void explorer.ensureLoaded(node.relPath)}
        onactivate={(node: FileNode) => {
          if (!node.isDir) {
            explorer.openFile(node);
          }
        }}
        style={{ flex: 1 }}
      >
        {#snippet row(node: FileNode, info: TreeRow)}
          {@const change = explorer.changeOf(node.relPath)}
          <View
            style={{ direction: "row", align: "center", gap: 6, flex: 1, minWidth: 0, height: "full", fontSize: fontSize.xs }}
            buttons={["right"]}
            ondown={(event: PointerEvent) => openMenu(event, node, info)}
            onpress={(event: PointerEvent) => pressRow(event, node, info)}
          >
            <Icon svg={node.isDir ? (info.expanded ? folderOpen : folder) : file} size={14} color={nameColor(node)} />
            <Text style={{ flex: 1, minWidth: 0, truncate: true, color: nameColor(node) }}>{node.name}</Text>
            {#if change !== undefined && !node.isDir}
              <Text style={{ shrink: 0, fontFamily: "mono", fontSize: fontSize.xxs, color: changeColors[change] }}>{changeLetters[change]}</Text>
            {/if}
          </View>
        {/snippet}
      </Tree>
    </View>
  {/if}
  <ContextMenu bind:this={menu} menuStyle={{ minWidth: 240 }} />
</View>
