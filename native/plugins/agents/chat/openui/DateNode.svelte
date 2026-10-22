<script lang="ts">
  // A date: the text field (checked as `YYYY-MM-DD`) and a button that opens a month to pick a day from.
  import { Button, Icon, Popover, Text, View } from "@neoworks/svelte-gpui/ui";
  import calendar from "@phosphor-icons/core/regular/calendar-blank.svg";
  import { neouiPalette } from "./look";
  import { dateParts, dateText, textOf } from "./form";
  import { MONTHS, monthGrid, shiftMonth, WEEKDAYS } from "./calendar";
  import { useDoc } from "./context";
  import { calendarId } from "./focus";
  import TextField from "./TextField.svelte";
  import type { NodeProps } from "./Node.svelte";

  let { node, path, width, fill }: NodeProps = $props();
  const p = neouiPalette;
  const doc = useDoc();

  const value = $derived(dateParts(textOf(doc.value(node))));
  const now = new Date();
  const today = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  let open = $state(false);
  let button: { focus(): void } | undefined = $state();
  $effect(() => {
    if (node.key === undefined || doc.streaming) return;
    return doc.view.register(calendarId(node.key), () => button?.focus());
  });
  /** The month shown: the date's, else today's, until the arrows move it. */
  let shown = $state<{ year: number; month: number }>();
  const month = $derived.by(() => {
    if (shown !== undefined) return shown;
    return value ?? today;
  });
  const weeks = $derived(monthGrid(month.year, month.month));

  function pick(day: number): void {
    doc.input(node, dateText(month.year, month.month, day));
    open = false;
  }
</script>

<View style={{ direction: "row", align: "start", gap: 8, maxWidth: 520 }}>
  <View style={{ flex: 1, minWidth: 0 }}>
    <TextField {node} {path} {width} {fill} onopen={() => ((shown = undefined), (open = true))} />
  </View>
  <Popover
    bind:open
    side="bottom"
    align="end"
    offset={6}
    focusPanel={false}
    style={{ padding: 10, background: p.surface, radius: p.radius.m, borderWidth: 1, borderColor: p.border, shadow: { y: 8, blur: 24, color: "rgba(0, 0, 0, 0.5)" } }}
  >
    {#snippet trigger({ toggle })}
      <Button
        bind:this={button}
        onpress={() => {
          shown = undefined;
          toggle();
        }}
        disabled={doc.streaming}
        style={{ size: 38, align: "center", justify: "center", radius: p.radius.s, borderWidth: 1, borderColor: p.border, background: p.bg, color: p.muted }}
        hover={{ color: p.fg, borderColor: p.muted }}
        focus={{ borderColor: p.accent }}
      >
        <Icon svg={calendar} size={18} />
      </Button>
    {/snippet}
    {#snippet children()}
      <View style={{ width: 224, gap: 6 }}>
        <View style={{ direction: "row", align: "center", justify: "between" }}>
          <Button onpress={() => (shown = shiftMonth(month.year, month.month, -1))} style={{ size: 28, align: "center", justify: "center", radius: 14, color: p.muted }} hover={{ background: p.raised, color: p.fg }}>
            <Text style={{ fontSize: 16 }}>‹</Text>
          </Button>
          <Text style={{ fontWeight: "medium" }}>{MONTHS[month.month - 1]} {month.year}</Text>
          <Button onpress={() => (shown = shiftMonth(month.year, month.month, 1))} style={{ size: 28, align: "center", justify: "center", radius: 14, color: p.muted }} hover={{ background: p.raised, color: p.fg }}>
            <Text style={{ fontSize: 16 }}>›</Text>
          </Button>
        </View>
        <View style={{ direction: "row" }}>
          {#each WEEKDAYS as name}
            <Text style={{ width: 32, textAlign: "center", color: p.muted, fontSize: 11 }}>{name}</Text>
          {/each}
        </View>
        {#each weeks as week}
          <View style={{ direction: "row" }}>
            {#each week as day}
              {#if day === undefined}
                <View style={{ width: 32, height: 30 }} />
              {:else}
                {@const chosen = value?.year === month.year && value.month === month.month && value.day === day}
                {@const here = today.year === month.year && today.month === month.month && today.day === day}
                <Button
                  onpress={() => pick(day)}
                  style={{ width: 32, height: 30, align: "center", justify: "center", radius: 6, background: chosen ? p.accent : undefined, color: chosen ? p.bg : p.fg, borderWidth: here && !chosen ? 1 : 0, borderColor: p.accent }}
                  hover={{ background: chosen ? p.accent : p.raised }}
                >
                  <Text style={{ fontSize: 13 }}>{day}</Text>
                </Button>
              {/if}
            {/each}
          </View>
        {/each}
      </View>
    {/snippet}
  </Popover>
</View>
