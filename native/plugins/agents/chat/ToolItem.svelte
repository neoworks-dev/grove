<script lang="ts">
  // A tool call: a header (its state, its title) and the result, collapsed to a few lines until
  // pressed. A question (buttons) is always open, so it can be answered where it is asked, and
  // a stub while the composer answers it.
  import { Text, View } from "@neoworks/svelte-gpui/ui";
  import type { ViewItem } from "@suite/protocol/types";
  import { palette } from "../palette";
  import { hasButtons } from "./components";
  import { useChat } from "./context";
  import Component from "./Component.svelte";
  import ItemFrame from "./ItemFrame.svelte";
  import { GUTTER, PREVIEW_LINES } from "./layout";
  import Spinner from "./Spinner.svelte";
  import { chatView } from "./viewState";
  import Summary from "./Summary.svelte";

  let { item }: { item: ViewItem } = $props();

  const p = palette;
  const chat = useChat();

  const question = $derived(hasButtons(item.component));
  const open = $derived(chatView.expanded || chatView.isOpened(item.ref));
  /** The composer is answering this question, so the chat keeps a stub for it. */
  const stub = $derived(chat.isAnswering(item.ref) && !chatView.expanded);

  const stateColor = $derived.by(() => {
    if (item.state === "done") return p.success;
    if (item.state === "failed") return p.danger;
    return item.state === "running" ? p.accent : p.muted;
  });
</script>

{#snippet glyph()}
  <View style={{ width: GUTTER, color: stateColor }}>
    {#if item.state === "running"}
      <Spinner />
    {:else if item.state === "done"}
      <Text>✓</Text>
    {:else if item.state === "failed"}
      <Text>✗</Text>
    {:else}
      <Text>○</Text>
    {/if}
  </View>
{/snippet}

<ItemFrame>
  {#if stub}
    <View style={{ direction: "row", paddingX: p.space.l }}>
      <Text style={{ width: GUTTER, color: p.accent }}>●</Text>
      <Text>
        <Text style={{ fontWeight: "bold" }}>{item.label ?? "a question"}</Text>
        <Text style={{ color: p.muted }}>{" · answer below"}</Text>
      </Text>
    </View>
  {:else}
    <View style={{ paddingX: p.space.l }}>
      <View
        onpress={question ? undefined : () => chatView.toggleOpened(item.ref)}
        style={{ direction: "row", cursor: question ? undefined : "pointer" }}
      >
        {@render glyph()}
        <Text style={{ fontWeight: "bold", flex: 1, minWidth: 0 }}>{item.label ?? ""}</Text>
      </View>
      <View style={{ paddingLeft: GUTTER, paddingTop: 2 }}>
        {#if question || open}
          <Component
            component={item.component}
            ref={item.ref}
            limit={question && !chatView.expanded ? PREVIEW_LINES : undefined}
          />
        {:else}
          <View onpress={() => chatView.toggleOpened(item.ref)} style={{ cursor: "pointer", color: p.muted }}>
            <Summary component={item.component} ref={item.ref} />
          </View>
        {/if}
      </View>
    </View>
  {/if}
</ItemFrame>
