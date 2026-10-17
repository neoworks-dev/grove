// The questions the agent asks (a permission or a choice) arrive as chat items with buttons. The
// composer answers them in a panel in place of the input: which item that is, what it shows, and
// when it takes over. Plain functions, so they are tested without a window. Ported from
// neoworks-harness apps/gui (plugins/composer/prompt.ts).

import type { Block, Component, Span, ViewItem } from "@suite/protocol/types";

/** How long the user must not have typed before a question takes the input's place. */
export const TYPING_PAUSE_MS = 800;

export interface PromptButton {
  label: string;
  action: string;
  args?: unknown;
  /** The key the daemon suggests (its 1-based position). */
  key?: string;
  /** The value in effect now: the panel starts here. */
  current: boolean;
  /** What a choice says about this option, shown while it is selected. */
  description?: string;
}

export interface Prompt {
  /** The chat item, for the action that answers it. */
  ref: string;
  title: string;
  /** Everything but the buttons: details, a diff, text. */
  body: Component[];
  buttons: PromptButton[];
}

/** The text of a run of blocks, paragraphs and list items on lines of their own. */
export function plainText(blocks: readonly Block[]): string {
  const spans = (list: readonly Span[]): string => list.map((span) => span.text).join("");
  const lines: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "heading":
        lines.push(spans(block.spans));
        break;
      case "code_block":
        lines.push(block.code);
        break;
      case "list":
        for (const item of block.items) {
          lines.push(`- ${plainText(item.blocks)}`);
        }
        break;
      case "quote":
        lines.push(plainText(block.blocks));
        break;
      case "rule":
        break;
    }
  }
  return lines.join("\n");
}

/** Whether a button is in the component or anywhere below it. */
function containsButton(component: Component): boolean {
  switch (component.type) {
    case "button":
      return true;
    case "card":
    case "row":
    case "stack":
      return component.children.some(containsButton);
    default:
      return false;
  }
}

/**
 * Splits an item's component into its buttons (in drawing order) and the rest. In a row, text
 * after a button is that button's description (a choice's option text).
 */
export function splitPrompt(root: Component): { body: Component[]; buttons: PromptButton[] } {
  const body: Component[] = [];
  const buttons: PromptButton[] = [];

  const walk = (component: Component, inRow: boolean): void => {
    if (component.type === "button") {
      const { label, action, args, key, current } = component;
      buttons.push({ label, action, args, key, current: current === true });
      return;
    }
    if (!containsButton(component)) {
      const last = buttons[buttons.length - 1];
      if (inRow && last !== undefined && component.type === "text" && last.description === undefined) {
        last.description = plainText(component.blocks);
      } else {
        body.push(component);
      }
      return;
    }
    if (component.type === "card" || component.type === "row" || component.type === "stack") {
      for (const child of component.children) {
        walk(child, component.type === "row");
      }
    }
  };

  walk(root, false);
  return { body, buttons };
}

/** The item as a prompt, or undefined when it has no buttons. */
export function promptOf(item: ViewItem): Prompt | undefined {
  const { body, buttons } = splitPrompt(item.component);
  if (buttons.length === 0) {
    return undefined;
  }
  let title = "";
  if (item.label !== undefined) {
    title = item.label;
  }
  return { ref: item.ref, title, body, buttons };
}

/** The prompts still waiting for an answer, oldest first. */
export function openPrompts(items: readonly ViewItem[]): Prompt[] {
  const prompts: Prompt[] = [];
  for (const item of items) {
    if (item.state !== "pending") {
      continue;
    }
    const prompt = promptOf(item);
    if (prompt !== undefined) {
      prompts.push(prompt);
    }
  }
  return prompts;
}

/** The prompt the keys answer: the oldest open one the user has not put aside with Esc. */
export function activePrompt(items: readonly ViewItem[], dismissed: ReadonlySet<string>): Prompt | undefined {
  return openPrompts(items).find((prompt) => !dismissed.has(prompt.ref));
}

/** The button a prompt starts on: the one in effect now, else the first. */
export function startButton(buttons: readonly PromptButton[]): number {
  const current = buttons.findIndex((button) => button.current);
  if (current < 0) {
    return 0;
  }
  return current;
}

/** Whether Tab can add a note: permission and choice answers carry one, other buttons do not. */
export function takesNote(button: PromptButton | undefined): boolean {
  if (button === undefined) {
    return false;
  }
  const answers = button.action === "suite.permit" || button.action === "suite.choose";
  return answers && typeof button.args === "object" && button.args !== null;
}

/** The text a `copy:` button puts on the clipboard; undefined for buttons that act on the daemon. */
export function copyText(button: PromptButton): string | undefined {
  const prefix = "copy:";
  if (!button.action.startsWith(prefix)) {
    return undefined;
  }
  return button.action.slice(prefix.length);
}

/** The button's args with the user's note (when there is one) for the agent. */
export function argsWithNote(button: PromptButton, note: string): unknown {
  const text = note.trim();
  if (text === "" || typeof button.args !== "object" || button.args === null) {
    return button.args;
  }
  return { ...button.args, note: text };
}

/**
 * Whether the prompt has taken the input's place. It waits for a pause in typing (so a card
 * appearing mid-sentence does not swallow keystrokes), but once shown it stays until answered or
 * put aside.
 */
export function promptEngaged(state: { hasPrompt: boolean; engaged: boolean; now: number; typedAt: number }): boolean {
  if (!state.hasPrompt) {
    return false;
  }
  return state.engaged || state.now - state.typedAt >= TYPING_PAUSE_MS;
}

/** The first lines of a diff, code or text body for the compact panel. */
export function previewLines(text: string, max: number): { lines: string[]; more: number } {
  const all = text.split("\n");
  return { lines: all.slice(0, max), more: Math.max(0, all.length - max) };
}
