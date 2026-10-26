// What can follow a half-typed vim command in the editor, for the which-key panel. The editor's
// vim layer lives in Rust (`editor-core/src/vim/parse.rs`) and only reports the keys typed so far,
// so this is a table of what that parser accepts after each prefix. Keep the two in step: a key
// listed here that the parser does not take would show in the panel and then do nothing.

import type { NextKey } from "../../kernel/keymap";

/** A key that runs something, for the tables below. */
function action(key: string, description: string): NextKey {
  return { key, description, continues: false };
}

/** A key that waits for more keys, shown as `+group`. */
function group(key: string, name: string): NextKey {
  return { key, continues: true, group: name };
}

const MOTIONS_AFTER_G: NextKey[] = [
  action("g", "First line"),
  action("e", "Back to word end"),
  action("E", "Back to WORD end"),
  action("_", "Last non-blank"),
  action("j", "Down a line"),
  action("k", "Up a line"),
];

const CASE_OPERATORS: NextKey[] = [group("u", "Lowercase"), group("U", "Uppercase"), group("~", "Toggle case")];

const NORMAL_G: NextKey[] = [
  ...MOTIONS_AFTER_G,
  ...CASE_OPERATORS,
  action("J", "Join lines"),
  action("p", "Put after, cursor past it"),
  action("P", "Put before, cursor past it"),
  action("I", "Insert at column 1"),
  action("v", "Reselect last selection"),
];

const VISUAL_G: NextKey[] = [
  ...MOTIONS_AFTER_G,
  action("u", "Lowercase"),
  action("U", "Uppercase"),
  action("~", "Toggle case"),
];

const SCROLL: NextKey[] = [action("t", "Line to top"), action("z", "Line to centre"), action("b", "Line to bottom")];

const REGISTERS: NextKey[] = [
  action('"', "Unnamed register"),
  action("+", "Clipboard"),
  action("*", "Primary selection"),
  action("_", "Black hole"),
  action("-", "Small delete"),
  action("a–z", "Named register"),
];

const TEXT_OBJECTS: NextKey[] = [
  action("w", "Word"),
  action("W", "WORD"),
  action("s", "Sentence"),
  action("p", "Paragraph"),
  action("t", "Tag"),
  action('"', "Double quotes"),
  action("'", "Single quotes"),
  action("`", "Backticks"),
  action("( b", "Parentheses"),
  action("{ B", "Braces"),
  action("[", "Brackets"),
  action("<", "Angle brackets"),
];

/** What an operator acts on, after the key that names the whole line. */
const OPERATOR_TARGETS: NextKey[] = [
  group("i", "Inside"),
  group("a", "Around"),
  action("w", "To next word"),
  action("b", "To previous word"),
  action("e", "To word end"),
  action("$", "To line end"),
  action("0", "To line start"),
  action("^", "To first non-blank"),
  action("j", "This line and the next"),
  action("k", "This line and the previous"),
  action("G", "To last line"),
  group("g", "Goto"),
  action("}", "To paragraph end"),
  action("{", "To paragraph start"),
  action("%", "To matching bracket"),
  action("f", "To a character"),
  action("t", "Till a character"),
];

const OPERATORS: Record<string, string> = {
  d: "d",
  c: "c",
  y: "y",
  ">": ">",
  "<": "<",
  gu: "u",
  gU: "U",
  "g~": "~",
};

/** What the operator does to its whole line, keyed by the key that repeats it. */
const WHOLE_LINE: Record<string, string> = {
  d: "Delete line",
  c: "Change line",
  y: "Yank line",
  ">": "Indent line",
  "<": "Outdent line",
  u: "Lowercase line",
  U: "Uppercase line",
  "~": "Toggle case of line",
};

const NORMAL_PREFIXES: Record<string, NextKey[]> = {
  g: NORMAL_G,
  z: SCROLL,
  "[": [action("c", "Previous change")],
  "]": [action("c", "Next change")],
  '"': REGISTERS,
  "@": [action("@", "Last macro again"), action("a–z", "Play macro")],
  q: [action("a–z", "Record macro")],
};

/**
 * The keys that can follow what vim has pending, or an empty list when the pending keys are not a
 * prefix the table knows. `pending` is the editor's pending keys run together, as `"a2d`.
 */
export function vimNextKeys(pending: string, mode: string): NextKey[] {
  if (pending === "") {
    return [];
  }
  if (pending === '"') {
    return REGISTERS;
  }
  const command = withoutCounts(withoutRegister(pending));
  if (mode === "NORMAL") {
    return normalNextKeys(command);
  }
  if (mode === "VISUAL" || mode === "V-LINE" || mode === "V-BLOCK") {
    return visualNextKeys(command);
  }
  return [];
}

/** The keys that can follow a command in normal mode. */
function normalNextKeys(command: string): NextKey[] {
  const prefix = NORMAL_PREFIXES[command];
  if (prefix !== undefined) {
    return prefix;
  }
  const operator = operatorAtStart(command);
  if (operator === null) {
    return [];
  }
  return operatorNextKeys(operator, command.slice(operator.length));
}

/** The keys that can follow an operator and what was typed after it. */
function operatorNextKeys(operator: string, afterOperator: string): NextKey[] {
  const target = withoutCounts(afterOperator);
  const repeatKey = OPERATORS[operator];
  if (target === "") {
    return [action(repeatKey, WHOLE_LINE[repeatKey]), ...OPERATOR_TARGETS];
  }
  if (target === "i" || target === "a") {
    return TEXT_OBJECTS;
  }
  if (target === "g") {
    return MOTIONS_AFTER_G;
  }
  return [];
}

/** The keys that can follow a command in a visual mode, where operators act at once. */
function visualNextKeys(command: string): NextKey[] {
  if (command === "g") {
    return VISUAL_G;
  }
  if (command === "i" || command === "a") {
    return TEXT_OBJECTS;
  }
  if (command === "z" || command === "[" || command === "]" || command === "@" || command === "q") {
    return NORMAL_PREFIXES[command];
  }
  return [];
}

/** The operator the command starts with, longest first so `gu` is not read as `g`. */
function operatorAtStart(command: string): string | null {
  for (const operator of ["gu", "gU", "g~"]) {
    if (command.startsWith(operator)) {
      return operator;
    }
  }
  const first = command.charAt(0);
  if (OPERATORS[first] !== undefined) {
    return first;
  }
  return null;
}

/** The command without a register named in front of it, as in `"ay`. */
function withoutRegister(pending: string): string {
  if (pending.startsWith('"')) {
    return pending.slice(2);
  }
  return pending;
}

/** The command without a count in front of it; a leading zero is a motion, not a count. */
function withoutCounts(command: string): string {
  return command.replace(/^[1-9][0-9]*/, "");
}
