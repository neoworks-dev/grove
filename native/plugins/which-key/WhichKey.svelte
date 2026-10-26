<!--
  The hint for a half-typed key sequence, laid out like nvim's which-key: a narrow column in the
  bottom right corner, headed by the keys typed so far, with one row per key that can come next.
  A key that opens a further level shows its group, such as `+git`, instead of an action.

  It shows the app's key sequences, such as the leader's, at once. A half-typed vim command in the
  editor, such as `g` or `d`, is shown only once it has waited a moment, so keys typed in one go
  never flash it, as in nvim.
-->
<script lang="ts">
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeymapService, NextKey } from "../../kernel/keymap";
  import type { EditorService } from "../editor/service";
  import { colors, fontSize, overlayPanel, radius, size } from "../theme/tokens";
  import { vimNextKeys } from "./vimKeys";

  /** How long a vim command waits half typed before the panel lists what can finish it. */
  const VIM_HINT_DELAY_MS = 400;

  let { keymap, editor }: { keymap: KeymapService; editor: EditorService } = $props();

  const vimStatus = $derived(editor.vimStatus());
  const vimKeys = $derived(vimNextKeys(vimStatus.pending, vimStatus.mode));
  /** The vim pending keys the panel has waited out, so it may show them; empty while waiting. */
  let waitedPending = $state("");

  $effect(() => {
    const pending = vimStatus.pending;
    if (vimKeys.length === 0) {
      waitedPending = "";
      return;
    }
    const timer = setTimeout(() => {
      waitedPending = pending;
    }, VIM_HINT_DELAY_MS);
    return () => clearTimeout(timer);
  });

  const showVim = $derived(waitedPending !== "" && waitedPending === vimStatus.pending && vimKeys.length > 0);
  const keymapKeys = $derived(keymap.nextKeys());
  const nextKeys = $derived(chooseKeys(keymapKeys, showVim, vimKeys));
  const typed = $derived(typedKeys(keymapKeys.length > 0, vimStatus.pending));

  /** The keymap's sequence when one is pending, else vim's once it has waited, else nothing. */
  function chooseKeys(fromKeymap: NextKey[], vimShown: boolean, fromVim: NextKey[]): NextKey[] {
    if (fromKeymap.length > 0) {
      return fromKeymap;
    }
    if (vimShown) {
      return fromVim;
    }
    return [];
  }

  /** The header: the keymap's typed keys, or vim's pending keys as the editor reports them. */
  function typedKeys(keymapPending: boolean, vimPending: string): string {
    if (keymapPending) {
      return keymap.pendingKeys().map(keycap).join(" ");
    }
    return vimPending;
  }

  /** A key as the panel writes it: the space glyph is too faint at this size, so it is spelled out. */
  function keycap(key: string): string {
    if (key === "␣") {
      return "Space";
    }
    return key;
  }

  /** What a row says: the group a key opens, or the action it runs. */
  function label(next: NextKey): string {
    if (!next.continues) {
      if (next.description === undefined) {
        return "";
      }
      return next.description;
    }
    if (next.group === undefined) {
      return "+more";
    }
    return `+${next.group.toLowerCase()}`;
  }
</script>

{#if nextKeys.length > 0}
  <View style={{ position: "absolute", right: 16, bottom: size.statusBarHeight + 12, width: 300 }}>
    <View style={{ ...overlayPanel, direction: "column", paddingY: 6 }}>
      <Text
        style={{
          paddingX: 12,
          paddingTop: 2,
          paddingBottom: 6,
          fontFamily: "mono",
          fontSize: fontSize.xs,
          color: colors.muted,
        }}>{typed}</Text
      >
      {#each nextKeys as next (next.key)}
        <View style={{ direction: "row", align: "center", gap: 10, paddingX: 12, paddingY: 3 }}>
          <View style={{ width: 56, direction: "row" }}>
            <Text
              style={{
                paddingX: 6,
                paddingY: 1,
                radius: radius.sm,
                background: colors.lineFaint,
                color: colors.accent,
                fontFamily: "mono",
                fontSize: fontSize.xs,
              }}>{keycap(next.key)}</Text
            >
          </View>
          <Text
            style={{
              flex: 1,
              minWidth: 0,
              truncate: true,
              fontSize: fontSize.xs,
              color: next.continues ? colors.blue : colors.text,
            }}>{label(next)}</Text
          >
        </View>
      {/each}
    </View>
  </View>
{/if}
