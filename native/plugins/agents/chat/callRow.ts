// What a tool call's one line says: the word for the tool and the argument that matters. Plain
// functions, so they are tested without a window.

import type { CallFacts } from "../calls";
import { oneLine } from "./components";
import { fileOfCall } from "./turns";

/** The argument that says what a call was for. */
export interface CallArgument {
  /** The file name, the command or the search, as one line. */
  text: string;
  /** Where the file is, shown dimmer after its name; absent for anything that is not a file. */
  directory?: string;
  /** The absolute path a press opens, for a call about a file. */
  path?: string;
}

/** The input fields a call may keep its command or search in, most telling first. */
const COMMAND_FIELDS = ["command", "cmd"];
const SEARCH_FIELDS = ["pattern", "query", "url"];

/** The text of the first of `fields` that the input has as a string. */
function stringField(input: unknown, fields: readonly string[]): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

/** The directory part of a path, cut to its last two folders. */
export function shortDirectory(path: string): string | undefined {
  const parts = path.split("/").filter((part) => part !== "");
  parts.pop();
  if (parts.length === 0) {
    return undefined;
  }
  if (parts.length <= 2) {
    return `${path.startsWith("/") ? "/" : ""}${parts.join("/")}/`;
  }
  return `…/${parts.slice(-2).join("/")}/`;
}

/** The file a call changed or read: its input's path, else the first file it changed. */
export function pathOfCall(call: CallFacts): string | undefined {
  const path = fileOfCall(call);
  if (path !== undefined) {
    return path;
  }
  if (call.diffs.length > 0) {
    return call.diffs[0].path;
  }
  return undefined;
}

/** The argument of a call, from its input; its title when the input says nothing better. */
export function argumentOf(call: CallFacts): CallArgument {
  const path = pathOfCall(call);
  if (path !== undefined) {
    const name = path.split("/").filter((part) => part !== "").pop();
    const argument: CallArgument = { text: name === undefined ? path : name, path };
    const directory = shortDirectory(path);
    if (directory !== undefined) {
      argument.directory = directory;
    }
    return argument;
  }
  const command = stringField(call.rawInput, COMMAND_FIELDS);
  if (command !== undefined) {
    return { text: oneLine(command) };
  }
  const search = stringField(call.rawInput, SEARCH_FIELDS);
  if (search !== undefined) {
    return { text: oneLine(search) };
  }
  return { text: oneLine(call.title) };
}
