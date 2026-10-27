<!--
  The agent's question (a permission or a choice) answered in place of the input: its title, a
  compact look at what it concerns, and one button per answer. The keyboard drives it: Left and
  Right (or Up and Down) move, Enter answers, 1 to 9 answer directly, Tab adds a note that goes
  with the answer, Esc puts the question aside. Ported from neoworks-harness apps/gui
  (plugins/composer).
-->
<script lang="ts">
  import { Button, Input, Scroll, Text, View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import type { ComposerModel } from "./composerModel";
  import { palette } from "./palette";
  import PromptBody from "./PromptBody.svelte";

  interface Props {
    model: ComposerModel;
    /** The pane this is drawn in has the focus. */
    paneFocused: boolean;
    /** Shift-Tab was pressed: the next approvals mode. */
    oncycle: () => void;
  }

  let { model, paneFocused, oncycle }: Props = $props();

  const p = palette;

  const prompt = $derived(model.prompt());
  const buttonIndex = $derived(model.button());
  const focused = $derived(prompt?.buttons[buttonIndex]);
  const hasBody = $derived(prompt !== undefined && prompt.body.length > 0);
  const note = $derived(model.note);
  /** The edit the question asks about, which the editor shows as a diff. */
  const editQuestion = $derived(model.editQuestion());

  let root: ReturnType<typeof View> | undefined = $state();
  let noteInput: ReturnType<typeof Input> | undefined = $state();

  // The keys go to the panel while its pane has the focus, as when the focus comes back from the
  // diff of the edit being asked about; when the note field opens they go there, and back after it.
  $effect(() => {
    if (!paneFocused) {
      return;
    }
    if (note === undefined) {
      root?.focus();
    } else {
      noteInput?.focus();
    }
  });

  /** The keys of the panel; shortcuts with a modifier belong to the window. */
  function key(event: KeyEvent): void {
    if (event.key === "Tab" && event.shift) {
      event.preventDefault();
      oncycle();
      return;
    }
    if (event.ctrl || event.alt || event.meta) {
      return;
    }
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        model.moveButton(-1);
        break;
      case "ArrowRight":
      case "ArrowDown":
        model.moveButton(1);
        break;
      case "Enter":
        model.press(buttonIndex);
        break;
      case "Tab":
        model.tab();
        break;
      case "Escape":
        model.escape();
        break;
      default: {
        const number = Number(event.key);
        if (Number.isInteger(number) && number >= 1 && prompt !== undefined && number <= prompt.buttons.length) {
          model.press(number - 1);
          break;
        }
        return;
      }
    }
    event.preventDefault();
    event.stopPropagation();
  }

  /** Enter in the note field answers with the note. */
  function noteKey(event: KeyEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      model.escape();
      return;
    }
    if (event.key !== "Enter" || event.shift || event.alt) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    model.press(buttonIndex);
  }
</script>

{#if prompt !== undefined}
  <View bind:this={root} focusable onkey={key} style={{ gap: p.space.m }}>
    <Text style={{ fontWeight: "bold" }}>{prompt.title || "The agent asks"}</Text>

    {#if hasBody}
      <Scroll style={{ maxHeight: 180 }}>
        <PromptBody components={prompt.body} onshowdiff={editQuestion === undefined ? undefined : () => model.reshowEdit()} />
      </Scroll>
    {/if}

    <View style={{ direction: "row", wrap: true, gap: p.space.m }}>
      {#each prompt.buttons as button, index}
        {@const chosen = index === buttonIndex}
        <Button
          onpress={() => {
            model.focusButton(index);
            model.press(index);
          }}
          style={{
            direction: "row",
            gap: p.space.s + 2,
            paddingX: p.space.m + 2,
            paddingY: p.space.s + 1,
            radius: 6,
            borderWidth: 1,
            borderColor: chosen ? p.accent : p.border,
            background: chosen ? p.accent : p.surface,
            color: chosen ? p.bg : p.fg,
            cursor: "pointer",
          }}
        >
          {#if index < 9}
            <Text style={{ color: chosen ? p.bg : p.muted }}>{index + 1}</Text>
          {/if}
          <Text style={{ fontWeight: button.current ? 600 : 400 }}>{button.label}{button.current ? " ✓" : ""}</Text>
        </Button>
      {/each}
    </View>

    {#if note !== undefined}
      <View style={{ direction: "row", gap: p.space.m, align: "center" }}>
        <Text style={{ color: p.accent }}>note</Text>
        <Input
          bind:this={noteInput}
          bind:value={model.note}
          placeholder={`for the agent, Enter answers "${focused?.label ?? ""}" with it`}
          style={{ flex: 1, minWidth: 0, color: p.fg }}
          onkey={noteKey}
        />
      </View>
    {:else}
      {#if focused?.description}
        <Text style={{ color: p.muted }}>{focused.description}</Text>
      {/if}
      <Text style={{ color: p.muted, fontSize: p.text.body - 1 }}>
        ←/→ choose · Enter answers · Tab adds a note · Esc writes a message instead
      </Text>
    {/if}
  </View>
{/if}
