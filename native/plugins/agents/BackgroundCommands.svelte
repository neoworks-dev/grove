<!--
  The commands an agent runs in the background, under the composer: a row each with what it is for,
  its last line of output, how long it has run and a button that stops it. Pressing a row shows its
  output as it streams. Ported from neo term's jobs list and terminal panel (apps/term).
-->
<script lang="ts">
  import { Button, Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { Layout } from "@neoworks/svelte-gpui/ui";
  import { jobTitle, lastLine, runtimeLabel, type BackgroundJob } from "./background";
  import type { ChatSession } from "./chatSession";
  import { palette } from "./palette";

  let { chat }: { chat: ChatSession } = $props();

  const p = palette;
  /** Rows of output shown under the list. */
  const OUTPUT_HEIGHT = 140;
  /** The newest lines of output kept in the view. */
  const OUTPUT_LINES_SHOWN = 40;

  const jobs = $derived(chat.backgroundJobs());
  let openId = $state<string | undefined>();
  const opened = $derived(jobs.find((job) => job.id === openId));

  let scroller: ReturnType<typeof Scroll> | undefined = $state();

  /** Keeps the newest line in view as the output grows. */
  function followEnd(box: Layout): void {
    scroller?.scrollTo(box.height);
  }

  /** What a row says about how the command stands: running, or how it ended. */
  function standing(job: BackgroundJob): string {
    if (job.endedMs === undefined) {
      return runtimeLabel(job, Date.now());
    }
    if (job.exit === 0) {
      return "done";
    }
    return `exit ${job.exit}`;
  }

  /** The colour of that: muted while it runs, green when it succeeded, red when it did not. */
  function standingColor(job: BackgroundJob): string {
    if (job.endedMs === undefined) {
      return p.muted;
    }
    if (job.exit === 0) {
      return p.success;
    }
    return p.danger;
  }
</script>

{#if jobs.length > 0}
  <View style={{ paddingX: p.space.l, paddingBottom: p.space.m, gap: 2 }}>
    <Text style={{ color: p.muted, fontWeight: "bold" }}>Background commands · {jobs.length}</Text>
    {#each jobs as job (job.id)}
      <View
        style={{ direction: "row", align: "center", gap: p.space.m, paddingX: p.space.s, radius: 4, background: job.id === openId ? p.band : undefined }}
        hover={{ background: p.band }}
        onpress={() => (openId = job.id === openId ? undefined : job.id)}
      >
        <Text style={{ color: p.accent, shrink: 0 }}>{job.endedMs === undefined ? "◐" : "●"}</Text>
        <Text style={{ shrink: 0, maxWidth: 240, truncate: true }}>{jobTitle(job)}</Text>
        <Text style={{ color: p.muted, flex: 1, minWidth: 0, truncate: true, fontFamily: "mono", fontSize: p.text.code }}>{lastLine(job) ?? ""}</Text>
        <Text style={{ color: standingColor(job), shrink: 0 }}>{standing(job)}</Text>
        {#if job.endedMs === undefined}
          <Button
            onpress={() => void chat.stopJob(job.id)}
            style={{ paddingX: p.space.s, radius: 4, color: p.danger, shrink: 0 }}
            hover={{ background: p.border }}
          >
            <Text>stop</Text>
          </Button>
        {/if}
      </View>
    {/each}
    {#if opened !== undefined}
      <Scroll bind:this={scroller} style={{ maxHeight: OUTPUT_HEIGHT, padding: p.space.s, radius: 4, background: p.surface }}>
        <View onlayout={followEnd}>
          {#each opened.output.slice(-OUTPUT_LINES_SHOWN) as line, index (index)}
            <Text style={{ fontFamily: "mono", fontSize: p.text.code, color: p.fg }}>{line}</Text>
          {/each}
        </View>
      </Scroll>
    {/if}
  </View>
{/if}
