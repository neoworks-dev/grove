<script lang="ts">
  // One view component, drawn natively: cards, rows, stacks, text, pictures, files, code,
  // diffs, tables, key-value lists, progress bars, buttons, links and neoui docs. Containers draw their
  // children with this same component.
  import { clipboard } from "@neoworks/svelte-gpui";
  import { Button, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { Component, Tone } from "@suite/protocol/types";
  import { baseName, gapOf, lineHeightOf, toneColor } from "./components";
  import { fitImage } from "./image";
  import { ITEM_INSET } from "./layout";
  import { columnWeights } from "./table";
  import { palette } from "../palette";
  import { useChat } from "./context";
  import Self from "./Component.svelte";
  import Blocks from "./Blocks.svelte";
  import CodeBlock from "./CodeBlock.svelte";
  import DiffView from "./DiffView.svelte";
  import ImageView from "./ImageView.svelte";
  import OpenUi from "./openui/OpenUi.svelte";

  interface Props {
    component: Component;
    /** The chat item this is part of: what a pressed button reports. */
    ref: string;
    /** Lines of code and diff to show before "… N more lines"; all when absent. */
    limit?: number;
  }

  let { component, ref, limit }: Props = $props();
  const p = palette;
  const session = useChat();

  /**
   * The most a picture takes: small in the chat, large when everything is expanded. A picture
   * without a known size gets a box of this size and is fitted inside it: the host lays an
   * `Image` out before it has loaded, and a row whose height changes afterwards is never
   * measured again.
   */
  const picture = $derived(
    limit === undefined ? { width: 560, height: 350 } : { width: 352, height: 220 },
  );

  function color(tone: Tone | undefined): string | undefined {
    return tone === undefined ? undefined : toneColor(tone, p);
  }

  function press(action: string, args: unknown): void {
    // copy:<text> never leaves the window.
    if (action.startsWith("copy:")) void clipboard.write(action.slice("copy:".length));
    else void session.action(ref, action, args);
  }
</script>

{#if component.type === "card"}
  <View style={{ borderLeftWidth: 2, borderColor: color(component.tone) ?? p.border, paddingLeft: p.space.m, gap: p.space.s }}>
    {#if component.title}
      <Text style={{ fontWeight: "bold", color: color(component.tone) }}>{component.title}</Text>
    {/if}
    {#each component.children as child}
      <Self component={child} {ref} {limit} />
    {/each}
  </View>
{:else if component.type === "row"}
  <View style={{ direction: "row", wrap: true, align: "center", columnGap: gapOf(component.gap, p) + p.space.s, rowGap: gapOf(component.gap, p) }}>
    {#each component.children as child}
      <Self component={child} {ref} {limit} />
    {/each}
  </View>
{:else if component.type === "stack"}
  <View style={{ gap: gapOf(component.gap, p) }}>
    {#each component.children as child}
      <Self component={child} {ref} {limit} />
    {/each}
  </View>
{:else if component.type === "text"}
  {@const size = component.role === "title" ? p.text.title : component.role === "code" ? p.text.code : p.text.body}
  <View
    style={{
      color: color(component.tone),
      fontSize: size,
      fontWeight: component.role === "title" ? 600 : undefined,
      fontFamily: component.role === "code" ? "mono" : undefined,
    }}
  >
    <Blocks blocks={component.blocks} {size} {ref} />
  </View>
{:else if component.type === "image"}
  {@const box = component.width && component.height ? fitImage({ width: component.width, height: component.height }, picture) : picture}
  <ImageView image={component} width={box.width} height={box.height} />
{:else if component.type === "file"}
  <View style={{ direction: "row", gap: p.space.m, align: "baseline", alignSelf: "start", background: p.surface, radius: 6, paddingX: p.space.m, paddingY: p.space.s }}>
    <Text style={{ fontWeight: "medium" }}>{component.name ?? baseName(component.path)}</Text>
    <Text style={{ color: p.muted, truncate: true }}>{component.path}</Text>
  </View>
{:else if component.type === "code"}
  <CodeBlock code={component.code} {limit} />
{:else if component.type === "diff"}
  <DiffView diff={component} {limit} />
{:else if component.type === "table"}
  {@const weights = columnWeights(component)}
  <View style={{ borderWidth: 1, borderColor: p.border, radius: 6, overflow: "hidden" }}>
    <View style={{ direction: "row", background: p.surface, paddingY: p.space.s }}>
      {#each weights as weight, column}
        <Text style={{ flex: weight, minWidth: 0, paddingX: p.space.m, fontWeight: "bold", truncate: true }}>{component.columns[column] ?? ""}</Text>
      {/each}
    </View>
    {#each component.rows as row}
      <View style={{ direction: "row", paddingY: p.space.s, borderTopWidth: 1, borderColor: p.border }}>
        {#each weights as weight, column}
          <Text style={{ flex: weight, minWidth: 0, paddingX: p.space.m, lineHeight: lineHeightOf(p.text.body) }}>{row[column] ?? ""}</Text>
        {/each}
      </View>
    {/each}
  </View>
{:else if component.type === "kv"}
  <View style={{ gap: 2 }}>
    {#each component.items as item}
      <View style={{ direction: "row", gap: p.space.m }}>
        <Text style={{ color: p.muted, width: 110 }}>{item.key}</Text>
        <Text style={{ flex: 1, minWidth: 0, color: color(item.tone), fontWeight: item.tone ? "bold" : undefined }}>{item.value}</Text>
      </View>
    {/each}
  </View>
{:else if component.type === "progress"}
  <View style={{ direction: "row", gap: p.space.m, align: "center" }}>
    <View style={{ width: 160, height: 6, radius: 3, background: p.border, overflow: "hidden" }}>
      <View style={{ width: `${Math.round(Math.min(1, Math.max(0, component.value || 0)) * 100)}%`, height: 6, background: p.accent }} />
    </View>
    <Text style={{ color: p.muted }}>{Math.round(Math.min(1, Math.max(0, component.value || 0)) * 100)}%{component.label ? ` ${component.label}` : ""}</Text>
  </View>
{:else if component.type === "button"}
  <Button
    onpress={() => press(component.action, component.args)}
    style={{ direction: "row", gap: p.space.s, align: "center", paddingX: p.space.m, paddingY: p.space.s, radius: 6, background: p.surface, borderWidth: 1, borderColor: p.border, transition: 120 }}
    hover={{ background: p.band, borderColor: p.accent }}
    active={{ background: p.border }}
  >
    {#if component.key}<Text style={{ color: p.accent, fontWeight: "bold" }}>{component.key}</Text>{/if}
    <Text>{component.label}</Text>
    {#if component.current}<Text style={{ color: p.success }}>✓</Text>{/if}
  </Button>
{:else if component.type === "openui"}
  <OpenUi ui={component.ui} {ref} inset={ITEM_INSET} />
{:else if component.type === "link"}
  <Text>
    <Text style={{ color: p.accent, underline: true }}>{component.text || component.url}</Text>{#if component.text && component.text !== component.url}<Text style={{ color: p.muted }}>{` (${component.url})`}</Text>{/if}
  </Text>
{/if}
