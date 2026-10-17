<!--
  One terminal, drawn by the host's terminal element. The shell, its screen and its input live in
  Rust under the terminal's id, so drawing this again, as moving or reopening a pane does, finds
  the same shell. The surface takes the keyboard when the service asks for it, and opens a file a
  Control-click chose.
-->
<script lang="ts">
  import { element, type ElementMethods } from "@neoworks/svelte-gpui";
  import { activeTerminalTheme, type TerminalTheme } from "../theme/terminalTheme";
  import type { TerminalInfo, TerminalService } from "./service";

  interface Props {
    service: TerminalService;
    terminal: TerminalInfo;
    /** The pane the terminal is in, whose focus follows the pressing in it; none for the panel. */
    onfocus?: () => void;
  }

  let { service, terminal, onfocus }: Props = $props();

  /** What the terminal element offers the app. */
  interface TerminalViewMethods {
    copy(): boolean;
    paste(): void;
    selectAll(): void;
    clear(): void;
    send(text: string): void;
    selection(): string | null;
  }

  /** Where a Control-click on a file path asks to go. */
  interface OpenPathEvent {
    path: string;
    line: number | null;
    column: number | null;
  }

  /** The terminal `src/terminal/view.rs` registers. */
  const Terminal = element<
    {
      session: { id: string; cwd: string };
      theme: TerminalTheme;
      fontSize: number;
      onfocus: () => void;
      onopenpath: (event: OpenPathEvent) => void;
    },
    TerminalViewMethods
  >("terminal");

  const FONT_SIZE = 13;

  let view = $state<ElementMethods<TerminalViewMethods> | null>(null);

  // The terminal that was asked to take the keyboard takes it once its view exists.
  $effect(() => {
    if (view !== null && service.focusRequest() === terminal.id) {
      view.focus();
      service.focusDone(terminal.id);
      service.seen(terminal.id);
    }
  });
</script>

<Terminal
  bind:this={view}
  style={{ flex: 1 }}
  key={`terminal-${terminal.id}`}
  session={{ id: terminal.id, cwd: terminal.cwd }}
  theme={activeTerminalTheme()}
  fontSize={FONT_SIZE}
  onfocus={() => {
    service.seen(terminal.id);
    onfocus?.();
  }}
  onopenpath={(event) => void service.openFile(event.path, event.line, event.column)}
/>
