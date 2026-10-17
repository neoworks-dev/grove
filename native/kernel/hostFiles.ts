// The profile's file access on the real host: svelte-gpui's `files` API. Kept apart from the
// profile code so that code runs under `bun test`, where there is no host to import.

import { FileError, files } from "@neoworks/svelte-gpui";
import type { ProfileFiles } from "./profile";

export const hostProfileFiles: ProfileFiles = {
  async readIfExists(path) {
    try {
      return await files.readText(path);
    } catch (error) {
      if (error instanceof FileError && error.code === "NotFound") {
        return null;
      }
      throw error;
    }
  },

  async configDirectory() {
    const paths = await files.paths();
    return paths.config;
  },

  // The app has no way to open a folder yet, so the folder it was started in stands in for
  // one. Once it has, this returns that folder instead.
  async openedFolder() {
    const paths = await files.paths();
    return paths.cwd;
  },
};
