<script lang="ts">
  // A view that takes the keyboard as one stop of the doc: Tab reaches it, and it tells the doc
  // when it has the keyboard. `children` is told whether it has it, to draw the state.
  import type { Snippet } from "svelte";
  import { View } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent, Style } from "@neoworks/svelte-gpui/ui";
  import { useDoc } from "./context";

  interface Props {
    /** The key of the node, or its path. */
    id: string;
    style?: Style;
    onkey?: (event: KeyEvent) => void;
    onpress?: () => void;
    disabled?: boolean;
    children: Snippet<[boolean]>;
  }

  let { id, style, onkey, onpress, disabled = false, children }: Props = $props();
  const doc = useDoc();
  let element: { focus(): void; blur(): void } | undefined = $state();
  let focused = $state(false);

  $effect(() => {
    if (disabled) return;
    return doc.view.register(id, () => element?.focus());
  });

  function key(event: KeyEvent): void {
    if (disabled) return;
    if (event.key === "Escape") {
      element?.blur();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onkey?.(event);
  }
</script>

<View
  bind:this={element}
  focusable={!disabled}
  {style}
  onkey={key}
  {onpress}
  onfocus={() => {
    focused = true;
    doc.view.focus = id;
  }}
  onblur={() => {
    focused = false;
    if (doc.view.focus === id) doc.view.focus = undefined;
  }}
>
  {@render children(focused)}
</View>
