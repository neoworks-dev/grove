<script lang="ts">
  // Input, TextArea and DatePicker: a text field. The field keeps its own text while it has the
  // keyboard and ignores what the daemon sends for it; typing goes to the daemon after a pause,
  // and a date only once it is `YYYY-MM-DD` or empty. Up and Down move on to the neighbouring
  // field (in a text area, from its first or last line), Enter presses the form's first button.
  import { untrack } from "svelte";
  import { Input } from "@neoworks/svelte-gpui/ui";
  import type { KeyEvent } from "@neoworks/svelte-gpui/ui";
  import { fieldLook, neouiPalette } from "./look";
  import { useDoc } from "./context";
  import FieldError from "./FieldError.svelte";
  import { sendable, textOf } from "./form";
  import { useForm } from "./formcontext";
  import { str } from "./props";
  import type { NodeProps } from "./Node.svelte";

  let { node, onopen }: NodeProps & { onopen?: () => void } = $props();
  const p = neouiPalette;
  const doc = useDoc();
  const form = useForm();

  const key = $derived(node.key ?? "");
  const kind = $derived(node.component === "DatePicker" ? "date" : "text");
  const area = $derived(node.component === "TextArea");
  const type = $derived(str(node, "type"));
  const placeholder = $derived(kind === "date" ? (str(node, "placeholder") ?? "YYYY-MM-DD") : str(node, "placeholder"));
  const error = $derived(str(node, "error") !== undefined);
  const off = $derived(doc.streaming);

  let element: { focus(): void; blur(): void; getSelection(): { firstRow: boolean; lastRow: boolean } | null } | undefined = $state();
  let focused = $state(false);
  const incoming = $derived(textOf(doc.value(node)));
  let text = $state(untrack(() => textOf(doc.value(node))));
  // A value chosen elsewhere (a day from the calendar) is held, and shows even while the field has the keyboard.
  const chosen = $derived(doc.view.held[key] !== undefined);
  $effect(() => {
    if (!focused || chosen) text = incoming;
  });
  $effect(() => doc.view.echoed(key, node.props["value"]));
  $effect(() => doc.view.register(key, () => element?.focus()));

  function edit(value: string): void {
    text = value;
    if (sendable(kind, value)) doc.input(node, value, { soon: true, hold: false });
  }

  function leave(): void {
    focused = false;
    if (doc.view.focus === key) doc.view.focus = undefined;
    if (sendable(kind, text)) doc.view.hold(key, text);
    doc.flush(node);
  }

  function submit(): void {
    const button = doc.firstButton(form());
    if (button !== undefined) doc.press(button);
  }

  function onkey(event: KeyEvent): void {
    if (event.key === "Escape") {
      element?.blur();
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === "ArrowDown" && event.alt && onopen !== undefined) {
      // As in most date pickers, Alt-Down opens the calendar.
      onopen();
      event.preventDefault();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const at = element?.getSelection();
      const edge = event.key === "ArrowDown" ? at?.lastRow : at?.firstRow;
      if (!area || edge === true) {
        if (doc.view.move(doc.rootNode, event.key === "ArrowDown" ? 1 : -1)) event.preventDefault();
      }
    }
  }
</script>

<Input
  bind:this={element}
  value={text}
  {placeholder}
  multiline={area}
  rows={area ? 3 : undefined}
  secure={type === "password"}
  numeric={type === "number"}
  disabled={off}
  oninput={edit}
  onsubmit={area ? undefined : submit}
  onfocus={() => {
    focused = true;
    doc.view.focus = key;
  }}
  onblur={leave}
  {onkey}
  style={{ ...fieldLook(p, { focused, error }), paddingX: 12, paddingY: 8, color: p.fg, maxWidth: 520, opacity: off ? 0.6 : undefined }}
  hover={off ? undefined : { borderColor: error ? p.danger : p.muted }}
  focus={off ? undefined : { borderColor: error ? p.danger : p.accent }}
/>
<FieldError {node} />
