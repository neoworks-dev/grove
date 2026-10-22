<script lang="ts">
  // One neoui doc (docs/neoui.md): the daemon's evaluated tree, drawn as cards, charts, fields and
  // buttons. It holds no state of its own beyond what is purely visual (state.svelte.ts); what the
  // user types or presses goes back to the daemon, which evaluates again and sends the item anew.
  import { clipboard, invoke } from "@neoworks/svelte-gpui";
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import type { UiDoc } from "@suite/protocol/types";
  import { useChat, useColumn } from "../context";
  import { provideDoc } from "./context";
  import { neouiPalette } from "./look";
  import Node from "./Node.svelte";
  import { DocSession } from "./session";
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

  /** Opens an address in the system's browser; when the host cannot, the address goes to the clipboard. */
  async function open(url: string): Promise<void> {
    try {
      await invoke("open_url", { url });
    } catch {
      await clipboard.write(url);
      chat.reportError(`Could not open ${url}; it is on the clipboard.`);
    }
  }

  const session = new DocSession(() => ({
    ref,
    ui,
    view,
    send: (item, action, args) => void chat.action(item, action, args),
    open: (url) => void open(url),
    copy: (text) => void clipboard.write(text),
  }));
  provideDoc(session);

  /** Tab and Shift-Tab walk the doc's fields and buttons once one of them has the keyboard. */
  function key(event: KeyEvent): void {
    if (event.key !== "Tab" || event.ctrl || event.alt || event.meta) return;
    if (!view.move(ui.root, event.shift ? -1 : 1)) return;
    event.preventDefault();
    event.stopPropagation();
  }
</script>

{#if ui.root !== undefined}
  <View style={{ marginY: 4 }} onkey={key}>
    <Node node={ui.root} path="" {width} />
  </View>
{:else if (ui.errors?.length ?? 0) > 0}
  <Text style={{ color: p.muted }}>[ui: {ui.errors?.[0]?.message}]</Text>
{/if}
