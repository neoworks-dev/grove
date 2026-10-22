<script lang="ts">
  // One neoui doc (docs/neoui.md): the daemon's evaluated tree, drawn as cards, charts and text. It
  // holds no state of its own beyond what is purely visual (state.svelte.ts); the daemon evaluates
  // the program and sends the item again whenever it changes.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { UiDoc } from "@suite/protocol/types";
  import { useChat, useColumn } from "../context";
  import { provideDoc } from "./context";
  import { neouiPalette } from "./look";
  import Node from "./Node.svelte";
  import { viewOf } from "./state.svelte";

  interface Props {
    ui: UiDoc;
    /** The chat item the doc is in: what the daemon addresses its actions to. */
    ref: string;
    /** Pixels the doc's surroundings take from the column, such as an indent. */
    inset?: number;
  }

  let { ui, ref, inset = 0 }: Props = $props();
  const p = neouiPalette;
  const chat = useChat();
  const column = useColumn();
  const width = $derived(Math.max(160, column.width - inset - 8));
  const view = $derived(viewOf(chat.sessionId, ref, ui.id));

  provideDoc({
    get view() {
      return view;
    },
  });
</script>

{#if ui.root !== undefined}
  <View style={{ marginY: 4 }}>
    <Node node={ui.root} path="" {width} />
  </View>
{:else if (ui.errors?.length ?? 0) > 0}
  <Text style={{ color: p.muted }}>[ui: {ui.errors?.[0]?.message}]</Text>
{/if}
