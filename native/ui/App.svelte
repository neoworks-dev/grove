<!--
  The native app's shell, composed by hand until the kernel's slots exist: header with the real
  menus, the two rails, a sidebar placeholder, the GPUI editor next to a second pane in a split
  with a draggable gutter, the bottom panel, and the status bar with the editor's cursor.
  Temporary: each part here becomes a plugin filling a slot.
-->
<script lang="ts">
  import { element, invoke } from "@neoworks/svelte-gpui";
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import chat from "@phosphor-icons/core/regular/chat.svg";
  import folder from "@phosphor-icons/core/regular/folder.svg";
  import gitBranch from "@phosphor-icons/core/regular/git-branch.svg";
  import robot from "@phosphor-icons/core/regular/robot.svg";
  import terminalWindow from "@phosphor-icons/core/regular/terminal-window.svg";
  import warning from "@phosphor-icons/core/regular/warning.svg";
  import { CORE_MENUS, CORE_MENU_ITEMS } from "../plugins/header/coreMenu";
  import CommandCenter from "../plugins/header/CommandCenter.svelte";
  import Header from "../plugins/header/Header.svelte";
  import Logo from "../plugins/header/Logo.svelte";
  import MenuBar from "../plugins/header/MenuBar.svelte";
  import WindowControls from "../plugins/header/WindowControls.svelte";
  import PaneLeaf from "../plugins/layout/PaneLeaf.svelte";
  import SplitTree from "../plugins/layout/SplitTree.svelte";
  import BottomPanel from "../plugins/panel/BottomPanel.svelte";
  import Rail, { type RailItem } from "../plugins/rails/Rail.svelte";
  import StatusBar, { type StatusItem } from "../plugins/statusbar/StatusBar.svelte";
  import TextItem from "../plugins/statusbar/TextItem.svelte";
  import { colors, fontSize, shell, size } from "../plugins/theme/tokens";
  import { DemoLayout } from "./demoLayout.svelte";
  import type { MenuBarItem } from "../plugins/header/menuModel";

  /** The editor `src/editor/mod.rs` registers, with the events it emits. */
  const Editor = element<{
    path: string;
    onopened?: (event: { path: string; lines: number }) => void;
    onerror?: (event: { path: string; message: string }) => void;
    onselections?: (event: { count: number; row: number; column: number; selected: boolean }) => void;
    ondirty?: (event: { modified: boolean }) => void;
    onsaved?: (event: { path: string }) => void;
  }>("editor");

  const layout = new DemoLayout();

  let path = $state("");
  let fileName = $state("");
  let modified = $state(false);
  let position = $state("Ln 1, Col 1");
  let lastCommand = $state("");
  let activeLeftRail = $state<Set<string>>(new Set(["explorer"]));
  let activeRightRail = $state<Set<string>>(new Set());
  let panelTabId = $state("terminal");
  let panelOpen = $state(true);

  const leftRailItems = $derived<RailItem[]>([
    { id: "explorer", icon: folder, title: "Explorer", order: 1, active: activeLeftRail.has("explorer") },
    { id: "git", icon: gitBranch, title: "Git changes", order: 2, active: activeLeftRail.has("git") },
    { id: "terminal", icon: terminalWindow, title: "Terminal", order: 3, active: activeLeftRail.has("terminal") },
  ]);

  const rightRailItems = $derived<RailItem[]>([
    { id: "agent", icon: robot, title: "Agent", order: 1, active: activeRightRail.has("agent") },
    { id: "chat", icon: chat, title: "Chat", order: 2, active: activeRightRail.has("chat") },
  ]);

  const statusItems = $derived<StatusItem[]>([
    { id: "branch", order: 1, align: "left", component: TextItem, props: { text: "main" } },
    { id: "command", order: 2, align: "left", component: TextItem, props: { text: lastCommand } },
    { id: "position", order: 1, align: "right", component: TextItem, props: { text: position } },
  ]);

  const panelTabs = [
    { id: "terminal", title: "Terminal", icon: terminalWindow },
    { id: "problems", title: "Problems", icon: warning },
  ];

  /** Flips one id in a rail's active set. */
  function toggled(ids: Set<string>, id: string): Set<string> {
    const next = new Set(ids);
    if (next.has(id)) {
      next.delete(id);
      return next;
    }
    next.add(id);
    return next;
  }

  /** The cursor as the status bar shows it. */
  function describeSelections(event: { count: number; row: number; column: number }): string {
    const place = `Ln ${event.row + 1}, Col ${event.column + 1}`;
    if (event.count === 1) {
      return place;
    }
    return `${place} · ${event.count} cursors`;
  }

  /** The last part of a path. */
  function baseName(fullPath: string): string {
    return fullPath.split("/").pop() ?? fullPath;
  }

  invoke<string>("initial_file").then((file) => {
    path = file;
  });
</script>

<View style={shell}>
  <Header>
    {#snippet left()}
      <Logo />
      <MenuBar
        menus={CORE_MENUS}
        items={CORE_MENU_ITEMS}
        onrun={(item: MenuBarItem) => (lastCommand = `ran ${item.commandId}`)}
      />
    {/snippet}
    {#snippet center()}
      <CommandCenter label="grove" onpress={() => (lastCommand = "ran files.find")} />
    {/snippet}
    {#snippet right()}
      <WindowControls versionLabel="v0.1.0 · native" onsettings={() => (lastCommand = "ran preferences")} />
    {/snippet}
  </Header>

  <View style={{ flex: 1, minHeight: 0, direction: "row" }}>
    <Rail items={leftRailItems} onselect={(id) => (activeLeftRail = toggled(activeLeftRail, id))} />
    <View style={{ width: size.gutter, shrink: 0 }} />
    <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
      <View style={{ flex: 1, minHeight: 0, direction: "row" }}>
        <SplitTree node={layout.root} host={layout}>
          {#snippet leaf(node)}
            {#if node.paneTypeId === "editor"}
              <PaneLeaf
                leafId={node.id}
                title={fileName}
                active={layout.focusedLeafId === node.id}
                onclose={() => layout.closeLeaf(node.id)}
                ondroppane={(dragged, zone) => layout.dropPane(dragged, node.id, zone)}
              >
                <Editor
                  style={{ flex: 1 }}
                  key="main"
                  {path}
                  onopened={(event) => {
                    fileName = baseName(event.path);
                    modified = false;
                  }}
                  ondirty={(event) => (modified = event.modified)}
                  onselections={(event) => (position = describeSelections(event))}
                />
              </PaneLeaf>
            {:else}
              <PaneLeaf
                leafId={node.id}
                title={node.paneTypeId === "sidebar" ? "Explorer" : "Notes"}
                active={layout.focusedLeafId === node.id}
                onclose={() => layout.closeLeaf(node.id)}
                ondroppane={(dragged, zone) => layout.dropPane(dragged, node.id, zone)}
              >
                <View style={{ padding: 12 }}>
                  <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>A placeholder pane.</Text>
                </View>
              </PaneLeaf>
            {/if}
          {/snippet}
        </SplitTree>
      </View>
      {#if panelOpen}
        <View style={{ height: 180, shrink: 0, direction: "row" }}>
          <BottomPanel tabs={panelTabs} bind:activeId={panelTabId} onclose={() => (panelOpen = false)}>
            {#snippet body(tab)}
              <View style={{ padding: 12 }}>
                <Text style={{ fontSize: fontSize.xs, color: colors.dim }}>{tab.title} panel placeholder.</Text>
              </View>
            {/snippet}
          </BottomPanel>
        </View>
      {/if}
    </View>
    <View style={{ width: size.gutter, shrink: 0 }} />
    <Rail items={rightRailItems} tooltipSide="left" onselect={(id) => (activeRightRail = toggled(activeRightRail, id))} />
  </View>

  <StatusBar items={statusItems} />
</View>
