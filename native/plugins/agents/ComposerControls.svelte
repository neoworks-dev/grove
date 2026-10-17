<!--
  The row under the composer, as Grove's original agent pane has it: the harness, the approvals
  mode as a dropdown, how full the context is and what it costs, and the model and effort. The
  harness and the model are the daemon's to change, so pressing them asks the daemon for its list
  of choices, as typing `/harness` or `/model` does. A second row names the mode in force.
-->
<script lang="ts">
  import { Button, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { ChatSession } from "./chatSession";
  import { approvalsChoices, modeLine, modelLine, usageLine } from "./composerControls";
  import ControlSelect from "./ControlSelect.svelte";
  import { palette } from "./palette";

  interface Props {
    session: ChatSession;
    /** A short message from the composer, such as "copied". */
    notice?: string;
  }

  let { session, notice }: Props = $props();

  const p = palette;
  const status = $derived(session.status());
  const usage = $derived(usageLine(status));
  const model = $derived(modelLine(status));
  const choices = approvalsChoices();

  /** A pause sign for the mode that asks before it acts, a play sign for the ones that do not. */
  function modeGlyph(approvals: string): string {
    if (approvals === "ask") {
      return "‖";
    }
    return "▸";
  }

  /** Asks the daemon to switch the approvals mode. */
  function setApprovals(value: string): void {
    void session.send(`/approvals ${value}`);
  }
</script>

<View style={{ gap: p.space.s }}>
  <View style={{ direction: "row", align: "center", gap: p.space.m, wrap: true }}>
    <Button
      onpress={() => void session.send("/harness")}
      style={{ paddingX: p.space.m, height: 22, radius: 4, borderWidth: 1, borderColor: p.border, color: p.fg, align: "center" }}
      hover={{ borderColor: p.accent }}
    >
      <Text style={{ fontSize: p.text.code }}>{status.harness}</Text>
    </Button>
    <ControlSelect value={status.approvals} options={choices} onchange={setApprovals} />
    {#if usage !== ""}
      <Text style={{ color: p.muted, fontSize: p.text.code, shrink: 0, nowrap: true }}>{usage}</Text>
    {/if}
    <View style={{ flex: 1, minWidth: 0 }} />
    {#if notice !== undefined}
      <Text style={{ color: p.accent, fontSize: p.text.code }}>{notice}</Text>
    {/if}
    <Button onpress={() => void session.send("/model")} style={{ color: p.muted }} hover={{ color: p.fg }}>
      <Text style={{ fontSize: p.text.code, shrink: 0, nowrap: true }}>{model === "" ? "model" : model}</Text>
    </Button>
  </View>
  <View style={{ direction: "row", gap: p.space.m }}>
    <Text style={{ color: p.muted, fontSize: p.text.code, shrink: 0, nowrap: true }}>{modeGlyph(status.approvals)} {modeLine(status.approvals)}</Text>
    <View style={{ flex: 1, minWidth: 0 }} />
    <Text style={{ color: p.muted, fontSize: p.text.code, shrink: 0, nowrap: true }}>shift-tab cycles</Text>
  </View>
</View>
