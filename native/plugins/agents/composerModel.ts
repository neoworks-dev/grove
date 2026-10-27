// What one composer holds: the draft, the `/` menu, the history and the question panel (a
// permission or choice card answered in place of the input). The composer's components draw it
// and call it, so they agree on what is open. One per session shown: another session has its own
// draft and its own history.

import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { ChatSession } from "./chatSession";
import type { EditQuestion } from "./editQuestions";
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
import {
  commandsFor,
  completion,
  isSlashWord,
  lookupCommand,
  matchingCommands,
  moveSelection,
  type SlashCommand,
} from "./slashCommands";
import { isImagePath, pastedImagePaths, withAttachment, type Attachment } from "./attachments";
import { accept, candidatesFor, entriesOf, mentionAt, type Candidate, type Mention } from "./mention";
import { todoText } from "./todos";

/** What the composer needs from the outside. */
export interface ComposerDeps {
  history: HistoryStore;
  /** Puts text on the system clipboard, for the `copy:` buttons of a question. */
  copyToClipboard: (text: string) => void;
  /** Reads the system clipboard for Ctrl+V; without it nothing is pasted. */
  clipboard?: ClipboardAccess;
}

/** A draft put aside: its text and its images. */
interface Stash {
  text: string;
  attachments: Attachment[];
}

/** What pasting needs from the system. */
export interface ClipboardAccess {
  /** Saves the clipboard's image to a file and gives its path, or null when it holds none. */
  image(): Promise<string | null>;
  text(): Promise<string>;
  /** Whether a file exists, so a pasted path that names nothing is pasted as text. */
  exists(path: string): Promise<boolean>;
}

/** How long "copied" stays in the composer's status line. */
const COPIED_NOTICE_MS = 1500;

/** How long the hint `/help` leaves in the status line stays. */
const HELP_NOTICE_MS = 6000;

/** How long a listing of the session's files is reused for `@` mentions. */
const FILES_FRESH_MS = 10_000;

export class ComposerModel {
  private chat: ChatSession;
  private deps: ComposerDeps;
  private draft = "";
  private walk = new History();
  private highlighted = 0;
  /** The text the menu was closed (Esc) for; typing more opens it again. */
  private closedMenuFor: string | undefined;
  /** The text the `@` list was closed (Esc) for; typing more opens it again. */
  private closedMentionFor: string | undefined;
  /** Where the input's cursor is; undefined means the end, as after a completion or a history step. */
  private cursor: number | undefined;
  /** The session's files and folders for `@` mentions, and when they were listed. */
  private entries: string[] = [];
  private filesLoadedAt = 0;
  private loadingFiles = false;
  private attached: Attachment[] = [];
  /** The draft put aside with Ctrl-S. */
  private stash: Stash | undefined;
  /** Questions put aside with Esc; they stay in the chat. */
  private dismissed: ReadonlySet<string> = new Set();
  /** The question has the input's place now. */
  private isEngaged = false;
  /** When the user last typed, for the pause before a question takes over. */
  private typedAt = 0;
  private focusedButton = 0;
  /** The note being typed for the focused button's answer; undefined while there is none. */
  private noteText: string | undefined;
  /** The edit whose diff the editor shows while its question waits, and what takes the diff away. */
  private shownEdit: EditQuestion | null = null;
  private editClosers: (() => void)[] = [];
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
    return matchingCommands(this.draft, this.allCommands()).length > 0;
  }

  /** Every command the session answers: ours, then those its harness lists. Reactive. */
  private allCommands(): SlashCommand[] {
    return commandsFor(this.chat.harness(), this.chat.harnessCommands());
  }

  /** The commands the menu lists; none while it is closed. Reactive. */
  commands(): SlashCommand[] {
    if (!this.menuVisible()) {
      return [];
    }
    return matchingCommands(this.draft, this.allCommands());
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
    this.run(command, "");
  }

  /** Runs a command with its arguments: the pane's own, or sent to the daemon like any text. */
  private run(command: SlashCommand, args: string): void {
    if (command.local) {
      this.runLocal(command.name, args);
      return;
    }
    this.send(`/${command.name}${args}`);
  }

  /** A command the pane handles itself; `text` is what was typed after its name. */
  private runLocal(name: string, text: string): void {
    if (name === "todo") {
      this.addTodo(text);
      return;
    }
    if (name === "help") {
      // The menu lists every command when only the slash is typed.
      this.draft = "/";
      this.closedMenuFor = undefined;
      this.say("Tab completes · Enter runs · Esc closes", HELP_NOTICE_MS);
    }
  }

  /** `/todo <text>`: a new item on the shared list; without text it says how to use it. */
  private addTodo(text: string): void {
    const item = todoText(`/todo ${text}`);
    if (item === "") {
      this.say("usage: /todo <what to do>", HELP_NOTICE_MS);
      return;
    }
    void this.chat.changeTodos({ action: "add", text: item });
  }

  // ---- @ mentions ----

  /** The input's cursor moved, as the input reports it; the mention is the word the cursor is in. */
  moved(cursor: number): void {
    if (cursor === this.cursor) {
      return;
    }
    this.cursor = cursor;
    this.changes.notify();
  }

  /** The `@word` at the cursor, while nothing else has the input: no question, no `/` menu, not closed with Esc. Reactive. */
  private mention(): Mention | undefined {
    this.changes.track();
    if (this.isEngaged || this.menuVisible() || this.closedMentionFor === this.draft) {
      return undefined;
    }
    let cursor = this.draft.length;
    if (this.cursor !== undefined) {
      cursor = Math.min(this.cursor, this.draft.length);
    }
    return mentionAt(this.draft, cursor);
  }

  /** The files the `@word` could be; none while no mention is being typed. Reactive. */
  mentionMatches(): Candidate[] {
    const mention = this.mention();
    if (mention === undefined) {
      return [];
    }
    this.loadFiles();
    return candidatesFor(this.entries, mention.query);
  }

  /** Whether the `@` list is open. Reactive. */
  mentionVisible(): boolean {
    return this.mentionMatches().length > 0;
  }

  /** Moves the list's highlight, wrapping around. */
  moveMention(delta: number): void {
    this.highlighted = moveSelection(this.highlighted, delta, this.mentionMatches().length);
    this.changes.notify();
  }

  /**
   * Puts the picked (else the highlighted) file in the draft in place of the `@word`, and returns
   * where the cursor goes; undefined when the list is closed.
   */
  acceptMention(candidate?: Candidate): number | undefined {
    const mention = this.mention();
    const matches = this.mentionMatches();
    if (mention === undefined || matches.length === 0) {
      return undefined;
    }
    let pick = candidate;
    if (pick === undefined) {
      pick = matches[Math.min(this.highlighted, matches.length - 1)];
    }
    let cursor = this.draft.length;
    if (this.cursor !== undefined) {
      cursor = Math.min(this.cursor, this.draft.length);
    }
    const accepted = accept(this.draft, cursor, mention, pick);
    this.draft = accepted.text;
    this.cursor = accepted.cursor;
    this.highlighted = 0;
    this.changes.notify();
    return accepted.cursor;
  }

  /** Lists the session's files for the mentions, again when the last listing is old. */
  private loadFiles(): void {
    if (this.loadingFiles || Date.now() - this.filesLoadedAt < FILES_FRESH_MS) {
      return;
    }
    this.loadingFiles = true;
    void this.chat.projectFiles().then((files) => {
      this.loadingFiles = false;
      this.filesLoadedAt = Date.now();
      this.entries = entriesOf(files);
      this.changes.notify();
    });
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
    if (text === "" && this.attached.length === 0) {
      return;
    }
    this.draft = "";
    this.changes.notify();
    const typedCommand = lookupCommand(text, this.allCommands());
    if (typedCommand !== undefined && typedCommand.local) {
      this.runLocal(typedCommand.name, text.replace(/^\/\S+/, ""));
      return;
    }
    this.send(text);
  }

  /** Sends text to the agent and keeps it in the history. */
  private send(text: string): void {
    if (text !== "" && this.walk.push(text)) {
      void this.deps.history.append(this.chat.sessionId, text);
    }
    // The images go with a message, not with a command.
    let images: string[] = [];
    if (!text.startsWith("/")) {
      images = this.attached.map((attachment) => attachment.path);
      this.attached = [];
    }
    void this.chat.send(text, undefined, images);
    // What was written in its place is out: the draft put aside comes back.
    if (this.draft.trim() === "" && this.attached.length === 0 && this.stash !== undefined && !text.startsWith("/")) {
      this.swapStash();
    }
  }

  // ---- the draft put aside ----

  /** Whether a draft is put aside (Ctrl-S). Reactive. */
  hasStash(): boolean {
    this.changes.track();
    return this.stash !== undefined;
  }

  /**
   * Ctrl-S: the draft and its images go aside and the input is free for another message, or the
   * draft put aside comes back, trading places with what is in the input now.
   */
  swapStash(): void {
    const current = { text: this.draft, attachments: this.attached };
    let aside: Stash | undefined;
    if (current.text.trim() !== "" || current.attachments.length > 0) {
      aside = current;
    }
    const back = this.stash;
    this.stash = aside;
    this.draft = "";
    this.attached = [];
    if (back !== undefined) {
      this.draft = back.text;
      this.attached = back.attachments;
    }
    this.cursor = undefined;
    this.highlighted = 0;
    this.walk.reset();
    this.changes.notify();
  }

  // ---- attached images ----

  /** The images attached to the draft, which go with the next message. Reactive. */
  attachments(): readonly Attachment[] {
    this.changes.track();
    return this.attached;
  }

  /** Attaches the image at an absolute path; one attached already is not added again. */
  attach(path: string): void {
    this.attached = withAttachment(this.attached, path);
    this.changes.notify();
    void this.chat.assetForFile(path).then((source) => this.previewed(path, source));
  }

  /** The preview of an attached image has a URL to load from. */
  private previewed(path: string, source: string | undefined): void {
    if (source === undefined) {
      return;
    }
    this.attached = this.attached.map((attachment) => {
      if (attachment.path === path) {
        return { ...attachment, source };
      }
      return attachment;
    });
    this.changes.notify();
  }

  /** Takes one image off the draft. */
  detach(id: number): void {
    this.attached = this.attached.filter((attachment) => attachment.id !== id);
    this.changes.notify();
  }

  /**
   * Ctrl+V: attaches the clipboard's image, or the image files its text names. Returns the text
   * to paste into the draft when the clipboard holds neither, and undefined when it was attached.
   */
  async paste(): Promise<string | undefined> {
    const clipboard = this.deps.clipboard;
    if (clipboard === undefined) {
      return "";
    }
    const image = await clipboard.image();
    if (image !== null) {
      this.attach(image);
      return undefined;
    }
    const text = await clipboard.text();
    const named = pastedImagePaths(text);
    if (named === undefined) {
      return text;
    }
    const existing: string[] = [];
    for (const path of named) {
      if (await clipboard.exists(path)) {
        existing.push(path);
      }
    }
    if (existing.length === 0) {
      return text;
    }
    for (const path of existing) {
      this.attach(path);
    }
    return undefined;
  }

  /** Attaches the image files among dropped paths; returns how many were images. */
  dropped(paths: readonly string[]): number {
    const images = paths.filter(isImagePath);
    for (const path of images) {
      this.attach(path);
    }
    return images.length;
  }

  /**
   * Puts text in the draft in place of the selection `start` to `end`, and returns where the
   * cursor goes.
   */
  insertText(text: string, start: number, end: number): number {
    this.draft = this.draft.slice(0, start) + text + this.draft.slice(end);
    this.cursor = start + text.length;
    this.walk.reset();
    this.changes.notify();
    return this.cursor;
  }

  // ---- the queue ----

  /**
   * Up in an empty editor with messages waiting: takes them back out of the queue into the editor,
   * one per paragraph, before whatever was typed meanwhile. Returns whether any came back.
   */
  async takeBackWaiting(): Promise<boolean> {
    if (this.chat.waiting().length === 0) {
      return false;
    }
    const inputs = await this.chat.unqueue();
    if (inputs.length === 0) {
      return false;
    }
    for (const input of inputs) {
      if (input.images === undefined) {
        continue;
      }
      for (const path of input.images) {
        this.attached = withAttachment(this.attached, path);
      }
    }
    const parts = inputs.map((input) => input.text);
    const typed = this.draft.trim();
    if (typed !== "") {
      parts.push(typed);
    }
    this.draft = parts.join("\n\n");
    this.walk.reset();
    this.changes.notify();
    return true;
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

  /** The edit the open question asks about, or undefined when it is about something else. Reactive. */
  editQuestion(): EditQuestion | undefined {
    return this.chat.editQuestionOf(this.prompt());
  }

  /** Shows the edit a question asks about as a diff in the editor, until `hideEdit`. */
  showEdit(question: EditQuestion): void {
    this.hideEdit();
    this.editClosers = [this.chat.showEditQuestion(question)];
    this.shownEdit = question;
  }

  /** Shows the diff of the edit being asked about again, such as after its pane was closed. */
  reshowEdit(): void {
    if (this.shownEdit === null) {
      return;
    }
    this.editClosers.push(this.chat.showEditQuestion(this.shownEdit));
  }

  /** Takes the diff of the edit being asked about away. */
  hideEdit(): void {
    for (const close of this.editClosers) {
      close();
    }
    this.editClosers = [];
    this.shownEdit = null;
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
    } else if (this.mentionVisible()) {
      this.closedMentionFor = this.draft;
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
