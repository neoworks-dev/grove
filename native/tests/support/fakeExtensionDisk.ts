import type { ExtensionFiles } from "../../kernel/extensions";
import type { ProfileFiles } from "../../kernel/profile";

/** An in-memory disk: every path that was written or given, with its text. */
export class Disk {
  files = new Map<string, string>();

  /** The extension store over the disk, with `/data` as the data directory. */
  extensionFiles(): ExtensionFiles {
    return {
      dataDirectory: async () => "/data",
      readIfExists: async (path) => this.files.get(path) ?? null,
      listDirectories: async (path) => this.directoriesIn(path),
      writeText: async (path, text) => {
        this.files.set(path, text);
      },
      removeDirectory: async (path) => {
        for (const file of [...this.files.keys()]) {
          if (file.startsWith(`${path}/`)) {
            this.files.delete(file);
          }
        }
      },
      installTarball: async (directory, name, tarball) => this.unpack(directory, name, tarball),
    };
  }

  /**
   * Stands in for the host's unpacking: a tarball here is the JSON of the package's files, and
   * unpacking puts them in the directory in place of what was there.
   */
  private unpack(directory: string, name: string, tarball: ArrayBuffer): { version: string } {
    const packed = JSON.parse(new TextDecoder().decode(tarball)) as Record<string, string>;
    const manifest = JSON.parse(packed["package.json"]) as { name: string; version: string; grove?: unknown };
    if (manifest.name !== name || manifest.grove === undefined) {
      throw new Error(`${name} is not a Grove extension`);
    }
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(`${directory}/`)) {
        this.files.delete(file);
      }
    }
    for (const [path, text] of Object.entries(packed)) {
      this.files.set(`${directory}/${path}`, text);
    }
    return { version: manifest.version };
  }

  /** The profile files over the disk, with `/config` as the config directory. */
  profileFiles(): ProfileFiles {
    return {
      readIfExists: async (path) => this.files.get(path) ?? null,
      configDirectory: async () => "/config",
      writeText: async (path, text) => {
        this.files.set(path, text);
      },
    };
  }

  /** Installs an extension: its package.json and the files beside it. */
  install(directory: string, grove: unknown, files: Record<string, string> = {}, name = directory): void {
    const root = `/data/extensions/${directory}`;
    this.files.set(`${root}/package.json`, JSON.stringify({ name, version: "1.0.0", grove }));
    for (const [path, text] of Object.entries(files)) {
      this.files.set(`${root}/${path}`, text);
    }
  }

  /** The names of the directories right under a path. */
  private directoriesIn(path: string): string[] {
    const names = new Set<string>();
    for (const file of this.files.keys()) {
      if (file.startsWith(`${path}/`)) {
        names.add(file.slice(path.length + 1).split("/")[0]);
      }
    }
    return [...names].filter((name) => !name.includes("."));
  }
}
