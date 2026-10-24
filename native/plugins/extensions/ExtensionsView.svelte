<!--
  The extensions view: the extensions installed in Grove, and a search of npm for more. An
  installed extension can be switched off or on, updated when npm has a newer version, and
  removed. A search result can be installed. The work itself is the `ExtensionBrowser`'s; this
  draws what it says and reports presses.
-->
<script lang="ts">
  import { Button, Icon, Input, List, Text, View } from "@neoworks/svelte-gpui/ui";
  import arrowClockwise from "@phosphor-icons/core/regular/arrow-clockwise.svg";
  import magnifyingGlass from "@phosphor-icons/core/regular/magnifying-glass.svg";
  import { untrack } from "svelte";
  import { colors, fontSize, radius } from "../theme/tokens";
  import type { ExtensionBrowser } from "./service";
  import type { InstalledRow, ResultRow, ViewRow } from "./model";

  interface Props {
    browser: ExtensionBrowser;
  }

  let { browser }: Props = $props();

  const rows = $derived(browser.rows());
  const notice = $derived(browser.notice());

  let query = $state("");

  // The first look at the view lists what npm has, and checks the installed ones for updates.
  $effect(() => {
    untrack(() => {
      void browser.search("");
      void browser.checkForUpdates();
    });
  });

  /** Searches for the typed text. */
  function submitSearch(): void {
    void browser.search(query);
  }

  /** Searches again and checks for updates again. */
  function refresh(): void {
    void browser.search(query);
    void browser.checkForUpdates();
  }

  /** The key of a row, so a row keeps its state when the list changes around it. */
  function rowKey(row: ViewRow): string {
    if (row.kind === "heading") {
      return `heading:${row.title}`;
    }
    if (row.kind === "message") {
      return `message:${row.text}`;
    }
    return `${row.kind}:${row.name}`;
  }

  /** The colour of the dot that says how an installed extension is doing. */
  function dotColor(row: InstalledRow): string {
    if (row.problem !== null) {
      return colors.red;
    }
    if (row.enabled) {
      return colors.green;
    }
    return colors.faint;
  }

  /** What the button that switches an extension offers. */
  function toggleLabel(row: InstalledRow): string {
    if (row.enabled) {
      return "Disable";
    }
    return "Enable";
  }

  /** The text colour of a one-line message. */
  function messageColor(tone: "quiet" | "bad"): string {
    if (tone === "bad") {
      return colors.red;
    }
    return colors.dim;
  }

  /** The title colour of an installed extension: dimmed while it is switched off. */
  function titleColor(row: InstalledRow): string {
    if (row.enabled) {
      return colors.text;
    }
    return colors.dim;
  }

  /** The words for what is happening to a package. */
  function activityText(row: InstalledRow | ResultRow): string {
    if (row.activity === "installing") {
      return "Installing…";
    }
    if (row.activity === "updating") {
      return "Updating…";
    }
    return "Removing…";
  }
</script>

{#snippet action(label: string, onpress: () => void)}
  <Button
    style={{ height: 22, paddingX: 8, align: "center", radius: radius.sm, fontSize: fontSize.xxs, background: colors.raised, color: colors.text }}
    hover={{ background: colors.hover }}
    {onpress}
  >
    <Text>{label}</Text>
  </Button>
{/snippet}

{#snippet dangerAction(label: string, onpress: () => void)}
  <Button
    style={{ height: 22, paddingX: 8, align: "center", radius: radius.sm, fontSize: fontSize.xxs, background: colors.raised, color: colors.red }}
    hover={{ background: colors.redSoft }}
    {onpress}
  >
    <Text>{label}</Text>
  </Button>
{/snippet}

<View style={{ flex: 1, minHeight: 0 }}>
  <View style={{ direction: "row", align: "center", gap: 6, paddingX: 12, paddingTop: 8, paddingBottom: 6 }}>
    <View style={{ direction: "row", align: "center", gap: 6, flex: 1, minWidth: 0, height: 26, paddingX: 8, radius: radius.sm, background: colors.input, borderWidth: 1, borderColor: colors.line }}>
      <Icon svg={magnifyingGlass} size={12} />
      <Input
        bind:value={query}
        placeholder="Search extensions on npm"
        onsubmit={submitSearch}
        style={{ flex: 1, minWidth: 0, fontSize: fontSize.xs }}
      />
    </View>
    <Button
      style={{ size: 26, align: "center", justify: "center", radius: radius.sm, color: colors.dim }}
      hover={{ background: colors.hover, color: colors.text }}
      onpress={refresh}
    >
      <Icon svg={arrowClockwise} size={13} />
    </Button>
  </View>

  {#if notice !== null}
    <View style={{ direction: "row", gap: 6, paddingX: 12, paddingBottom: 8 }}>
      <Text style={{ flex: 1, minWidth: 0, fontSize: fontSize.xxs, color: colors.red }}>{notice}</Text>
      <Button style={{ color: colors.dim }} onpress={() => browser.clearNotice()}><Text>Dismiss</Text></Button>
    </View>
  {/if}

  <List items={rows} key={(row) => rowKey(row)} style={{ flex: 1 }}>
    {#snippet row(entry)}
      {#if entry.kind === "heading"}
        <View style={{ height: 26, justify: "end", paddingX: 12, paddingBottom: 4 }}>
          <Text style={{ fontSize: fontSize.xxs, color: colors.dim, uppercase: true }}>{entry.title}</Text>
        </View>
      {:else if entry.kind === "message"}
        <View style={{ paddingX: 12, paddingY: 6 }}>
          <Text style={{ fontSize: fontSize.xs, color: messageColor(entry.tone) }}>{entry.text}</Text>
        </View>
      {:else if entry.kind === "installed"}
        <View style={{ gap: 3, paddingX: 12, paddingY: 8, borderWidth: 0 }} hover={{ background: colors.hover }}>
          <View style={{ direction: "row", align: "center", gap: 6 }}>
            <View style={{ size: 8, radius: 4, shrink: 0, background: dotColor(entry) }} />
            <Text style={{ flex: 1, minWidth: 0, truncate: true, fontSize: fontSize.sm, color: titleColor(entry) }}>{entry.title}</Text>
            <Text style={{ shrink: 0, fontFamily: "mono", fontSize: fontSize.xxs, color: colors.dim }}>{entry.version}</Text>
          </View>
          {#if entry.problem !== null}
            <Text style={{ fontSize: fontSize.xxs, color: colors.red }}>{entry.problem}</Text>
          {:else if entry.description !== ""}
            <Text style={{ truncate: true, fontSize: fontSize.xxs, color: colors.dim }}>{entry.description}</Text>
          {/if}
          {#if entry.activity !== null}
            <Text style={{ fontSize: fontSize.xxs, color: colors.muted }}>{activityText(entry)}</Text>
          {:else}
            <View style={{ direction: "row", gap: 6, paddingTop: 2 }}>
              {#if entry.update !== null}
                {@render action(`Update to ${entry.update}`, () => void browser.update(entry.name))}
              {/if}
              {@render action(toggleLabel(entry), () => void browser.setEnabled(entry.name, !entry.enabled))}
              {@render dangerAction("Remove", () => void browser.remove(entry.name))}
            </View>
          {/if}
        </View>
      {:else}
        <View style={{ gap: 3, paddingX: 12, paddingY: 8 }} hover={{ background: colors.hover }}>
          <View style={{ direction: "row", align: "center", gap: 6 }}>
            <Text style={{ flex: 1, minWidth: 0, truncate: true, fontSize: fontSize.sm, color: colors.text }}>{entry.name}</Text>
            <Text style={{ shrink: 0, fontFamily: "mono", fontSize: fontSize.xxs, color: colors.dim }}>{entry.version}</Text>
          </View>
          {#if entry.description !== ""}
            <Text style={{ truncate: true, fontSize: fontSize.xxs, color: colors.dim }}>{entry.description}</Text>
          {/if}
          <View style={{ direction: "row", align: "center", gap: 6, paddingTop: 2 }}>
            {#if entry.activity !== null}
              <Text style={{ fontSize: fontSize.xxs, color: colors.muted }}>{activityText(entry)}</Text>
            {:else if entry.installed}
              <Text style={{ fontSize: fontSize.xxs, color: colors.green }}>Installed</Text>
            {:else}
              {@render action("Install", () => void browser.install(entry.name))}
            {/if}
            {#if entry.publisher !== ""}
              <Text style={{ flex: 1, minWidth: 0, truncate: true, fontSize: fontSize.xxs, color: colors.faint }}>by {entry.publisher}</Text>
            {/if}
          </View>
        </View>
      {/if}
    {/snippet}
  </List>
</View>
