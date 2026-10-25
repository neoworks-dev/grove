// The review comments' file access on the real host: svelte-gpui's `files` API and the
// `data_directory` command. Kept apart from the store so that code runs under `bun test`, where
// there is no host to import.

import { FileError, files, invoke } from "@neoworks/svelte-gpui";
import type { ReviewFiles } from "./store";

export const hostReviewFiles: ReviewFiles = {
  async dataDirectory() {
    return invoke<string>("data_directory");
  },

  async readIfExists(path) {
    try {
      return await files.readText(path);
    } catch (error) {
      if (error instanceof FileError && (error.code === "NotFound" || error.code === "NotADirectory")) {
        return null;
      }
      throw error;
    }
  },

  async writeText(path, text) {
    const separator = path.lastIndexOf("/");
    await files.mkdir(path.slice(0, separator), { recursive: true });
    await files.writeText(path, text);
  },
};
