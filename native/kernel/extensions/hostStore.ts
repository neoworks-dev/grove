// The extension store on the real host: svelte-gpui's `files` API, and the `data_directory`
// command for where Grove keeps its data. Kept apart from the store so that code runs under
// `bun test`, where there is no host to import.

import { FileError, files, invoke } from "@neoworks/svelte-gpui";
import type { ToolsHost } from "./contributions";
import type { ExtensionFiles } from "./store";

/** Whether a file error says the path is not there. */
function isMissing(error: unknown): boolean {
  return error instanceof FileError && (error.code === "NotFound" || error.code === "NotADirectory");
}

export const hostExtensionFiles: ExtensionFiles = {
  async dataDirectory() {
    return invoke<string>("data_directory");
  },

  async readIfExists(path) {
    try {
      return await files.readText(path);
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  },

  async listDirectories(path) {
    try {
      const entries = await files.list(path);
      return entries.filter((entry) => entry.kind !== "file").map((entry) => entry.name);
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
  },

  async removeDirectory(path) {
    try {
      await files.remove(path, { recursive: true });
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  },

  async installTarball(directory, name, tarball, hashes) {
    return invoke<{ version: string }>(
      "install_extension",
      { directory, name, integrity: hashes.integrity, shasum: hashes.shasum },
      tarball,
    );
  },

  async writeText(path, text) {
    const separator = path.lastIndexOf("/");
    await files.mkdir(path.slice(0, separator), { recursive: true });
    await files.writeText(path, text);
  },
};

/** The host's tool installer and language server registry, which take what extensions contribute. */
export const hostToolsHost: ToolsHost = {
  async registerContributions(contributions) {
    await invoke("tools_register", { tools: contributions.tools });
    await invoke("lsp_register_servers", { servers: contributions.servers });
  },
};
