// A session's input history on disk, under the app's data directory. The walking itself is in
// history.ts; this part touches files, so a window is needed to run it.

import { files } from "@neoworks/svelte-gpui";
import { History, historyFile, historyLine, parseHistory, type HistoryStore } from "./history";

let directory: Promise<string> | undefined;

/** `<data>/suite/grove-history`, made on first use. */
function historyDirectory(): Promise<string> {
  if (directory === undefined) {
    directory = files.paths().then(async ({ data }) => {
      const path = `${data}/suite/grove-history`;
      await files.mkdir(path, { recursive: true });
      return path;
    });
  }
  return directory;
}

/** The history store of the running app. */
export function createHistoryStore(): HistoryStore {
  return {
    async load(session) {
      try {
        const file = historyFile(await historyDirectory(), session);
        if (file === undefined) {
          return new History();
        }
        return new History(parseHistory(await files.readText(file)));
      } catch {
        return new History();
      }
    },
    async append(session, text) {
      try {
        const file = historyFile(await historyDirectory(), session);
        if (file !== undefined) {
          await files.appendText(file, historyLine(text));
        }
      } catch {
        // History is a convenience.
      }
    },
  };
}
