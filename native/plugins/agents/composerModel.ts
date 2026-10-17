// What one composer holds: the draft, the `/` menu, the history and the question panel (a
// permission or choice card answered in place of the input). The composer's components draw it
// and call it, so they agree on what is open. One per session shown: another session has its own
// draft and its own history.

import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { ChatSession } from "./chatSession";
import { History, walksHistory, type HistoryStore } from "./history";
import {
  activePrompt,
  argsWithNote,
  copyText,
  promptEngaged,
  startButton,
  takesNote,
  TYPING_PAUSE_MS,
  type Prompt,
} from "./prompt";
import { SLASH_COMMANDS, completion, isSlashWord, matchingCommands, moveSelection, type SlashCommand } from "./slashCommands";

/** What the composer needs from the outside. */
export interface ComposerDeps {
  history: HistoryStore;
  /** Puts text on the system clipboard, for the `copy:` buttons of a question. */
  copyToClipboard: (text: string) => void;
}

/** How long "copied" stays in the composer's status line. */
const COPIED_NOTICE_MS = 1500;

export class ComposerModel {
  private chat: ChatSession;
  private deps: ComposerDeps;
  private draft = "";
  private walk = new History();
  private highlighted = 0;
  /** The text the menu was closed (Esc) for; typing more opens it again. */
  private closedMenuFor: string | undefined;
  /** Questions put aside with Esc; they stay in the chat. */
  private dismissed: ReadonlySet<string> = new Set();
  /** The question has the input's place now. */
  private isEngaged = false;
  /** When the user last typed, for the pause before a question takes over. */
  private typedAt = 0;
  private focusedButton = 0;
  /** The note being typed for the focused button's answer; undefined while there is none. */
  private noteText: string | undefined;
  private message: string | undefined;
  private messageTimer: ReturnType<typeof setTimeout> | undefined;
  private changes: ChangeSignal = createChangeSignal();

  constructor(chat: ChatSession, deps: ComposerDeps) {
    this.chat = chat;
    this.deps = deps;
  }

  /** The draft in the input. Kept while a question has the input's place. Reactive. */
  get text(): string {
    this.changes.track();
    return this.draft;
  }

  set text(value: string) {
    if (value === this.draft) {
      return;
    }
    this.draft = value;
    this.changes.notify();
  }

  /** A short message for the status line, such as "copied". Reactive. */
  notice(): string | undefined {
    this.changes.track();
    return this.message;
  }

  // ---- typing and the menu ----

  /** The text changed by typing (not by the history or a completion). */
  typed(): void {
    this.typedAt = Date.now();
    this.walk.reset();
    this.highlighted = 0;
    this.changes.notify();
  }

  /** The `/` menu's highlighted row. Reactive. */
  selected(): number {
    this.changes.track();
    return this.highlighted;
  }

  /** Highlights a row, as the pointer does when it moves over it. */
  select(index: number): void {
    if (index === this.highlighted) {
      return;
    }
    this.highlighted = index;
    this.changes.notify();
  }

  /** Whether the `/` menu is open: a command is being typed, matches something, and the menu was not closed for it. Reactive. */
  menuVisible(): boolean {
    this.changes.track();
    if (this.isEngaged || !isSlashWord(this.draft) || this.closedMenuFor === this.draft) {
      return false;
    }
    return matchingCommands(this.draft, SLASH_COMMANDS).length > 0;
  }

  /** The commands the menu lists; none while it is closed. Reactive. */
  commands(): SlashCommand[] {
    if (!this.menuVisible()) {
      return [];
    }
    return matchingCommands(this.draft, SLASH_COMMANDS);
  }

  /** Moves the menu's highlight, wrapping around. */
  moveMenu(delta: number): void {
    this.highlighted = moveSelection(this.highlighted, delta, this.commands().length);
    this.changes.notify();
  }

  /** The highlighted command, or undefined while the menu is closed. */
  private highlightedCommand(): SlashCommand | undefined {
    const commands = this.commands();
    if (commands.length === 0) {
      return undefined;
    }
    return commands[Math.min(this.highlighted, commands.length - 1)];
  }

  /** Tab: puts the highlighted command into the input with a space for arguments. */
  complete(): void {
    const command = this.highlightedCommand();
    if (command === undefined) {
      return;
    }
    this.draft = completion(command);
    this.highlighted = 0;
    this.changes.notify();
  }

  /** A menu pick (Enter or a press): sends the command, or leaves room for its arguments. */
  choose(command: SlashCommand): void {
    this.highlighted = 0;
    if (command.needsArgs) {
      this.draft = completion(command);
      this.changes.notify();
      return;
    }
    this.draft = "";
    this.changes.notify();
    this.send(`/${command.name}`);
  }

  // ---- sending ----

  /** Enter: the highlighted command when the menu is open, else the draft. */
  submit(): void {
    const command = this.highlightedCommand();
    if (command !== undefined) {
      this.choose(command);
      return;
    }
    const text = this.draft.trim();
    if (text === "") {
      return;
    }
    this.draft = "";
    this.changes.notify();
    this.send(text);
  }

  /** Sends text to the agent and keeps it in the history. */
  private send(text: string): void {
    if (this.walk.push(text)) {
      void this.deps.history.append(this.chat.sessionId, text);
    }
    void this.chat.send(text);
  }

  // ---- history ----

  /** Up or Down in the input. Returns whether it was used for the history. */
  walkHistory(direction: "older" | "newer", columns: number, forced: boolean): boolean {
    if (!walksHistory(this.draft, columns, forced)) {
      return false;
    }
    let text: string | undefined;
    if (direction === "older") {
      text = this.walk.older(this.draft);
    } else {
      text = this.walk.newer();
    }
    if (text === undefined) {
      return false;
    }
    this.draft = text;
    this.changes.notify();
    return true;
  }

  /** Loads what was sent in this session before. */
  async loadHistory(): Promise<void> {
    const loaded = await this.deps.history.load(this.chat.sessionId);
    this.walk = loaded;
  }

  // ---- the question panel ----

  /** The oldest open question that was not put aside. Reactive. */
  prompt(): Prompt | undefined {
    this.changes.track();
    return activePrompt(this.chat.items(), this.dismissed);
  }

  /** Whether the question has the input's place. Reactive. */
  engaged(): boolean {
    this.changes.track();
    return this.isEngaged && this.prompt() !== undefined;
  }

  /** A question is open but the user is typing, so the input stays with a hint above. Reactive. */
  waiting(): boolean {
    return this.prompt() !== undefined && !this.engaged();
  }

  /**
   * Settles whether the question has taken over, after the pause in typing. Returns how long to
   * wait before asking again while it has not, or undefined when nothing is waiting.
   */
  syncEngaged(): number | undefined {
    const prompt = this.prompt();
    const engaged = promptEngaged({
      hasPrompt: prompt !== undefined,
      engaged: this.isEngaged,
      now: Date.now(),
      typedAt: this.typedAt,
    });
    if (engaged !== this.isEngaged) {
      this.isEngaged = engaged;
      this.changes.notify();
    }
    if (prompt === undefined || engaged) {
      return undefined;
    }
    return Math.max(0, TYPING_PAUSE_MS - (Date.now() - this.typedAt));
  }

  /** The focused button of the question. Reactive. */
  button(): number {
    this.changes.track();
    return this.focusedButton;
  }

  /** Focuses a button, as the pointer does when it presses one. */
  focusButton(index: number): void {
    this.focusedButton = index;
    this.changes.notify();
  }

  /** A new question starts on its current (else its first) button. */
  startPrompt(prompt: Prompt | undefined): void {
    this.focusedButton = 0;
    if (prompt !== undefined) {
      this.focusedButton = startButton(prompt.buttons);
    }
    this.noteText = undefined;
    this.changes.notify();
  }

  /** Moves the focus to another button, wrapping around. */
  moveButton(delta: number): void {
    const prompt = this.prompt();
    if (prompt === undefined) {
      return;
    }
    this.focusedButton = moveSelection(this.focusedButton, delta, prompt.buttons.length);
    this.changes.notify();
  }

  /** The note being typed for the answer, or undefined while there is none. Reactive. */
  get note(): string | undefined {
    this.changes.track();
    return this.noteText;
  }

  set note(value: string | undefined) {
    this.noteText = value;
    this.changes.notify();
  }

  /** Tab on a button that takes a note opens the note field; on others it is "next button". */
  tab(): void {
    const prompt = this.prompt();
    if (prompt !== undefined && takesNote(prompt.buttons[this.focusedButton])) {
      this.note = "";
      return;
    }
    this.moveButton(1);
  }

  /** Answers with button `index` (and the note typed for it, if any). */
  press(index: number): void {
    const prompt = this.prompt();
    if (prompt === undefined) {
      return;
    }
    const button = prompt.buttons[index];
    if (button === undefined) {
      return;
    }
    // A copy button is the client's to handle: nothing goes to the daemon and the question stays.
    const copied = copyText(button);
    if (copied !== undefined) {
      this.deps.copyToClipboard(copied);
      this.say("copied", COPIED_NOTICE_MS);
      return;
    }
    let args = button.args;
    if (this.noteText !== undefined) {
      args = argsWithNote(button, this.noteText);
    }
    this.noteText = undefined;
    this.dismissed = new Set([...this.dismissed, prompt.ref]);
    this.changes.notify();
    void this.chat.action(prompt.ref, button.action, args);
  }

  /** Brings back the questions put aside. */
  reopenPrompts(): void {
    this.dismissed = new Set();
    this.changes.notify();
  }

  // ---- Esc ----

  /** Esc closes what is open, innermost first. Returns false when nothing was. */
  escape(): boolean {
    const prompt = this.prompt();
    if (this.menuVisible()) {
      this.closedMenuFor = this.draft;
    } else if (this.noteText !== undefined) {
      this.noteText = undefined;
    } else if (prompt !== undefined) {
      this.dismissed = new Set([...this.dismissed, prompt.ref]);
    } else {
      return false;
    }
    this.changes.notify();
    return true;
  }

  /** Shows a short message for a while. */
  private say(text: string, milliseconds: number): void {
    clearTimeout(this.messageTimer);
    this.message = text;
    this.changes.notify();
    this.messageTimer = setTimeout(() => {
      this.message = undefined;
      this.changes.notify();
    }, milliseconds);
  }

  /** Stops the message's timer, when the composer goes away. */
  dispose(): void {
    clearTimeout(this.messageTimer);
  }
}
