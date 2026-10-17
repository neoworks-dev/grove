// The `profile` service: reads the profile's layers and hands the rows to the loader. The
// project layer is the opened folder's `.grove/profile.json`, so it changes when a folder is
// opened, and the service rereads and reapplies the profile then. Rows that did not change
// stay loaded, so opening a folder only mounts or unloads the plugins its profile differs in.

import { Service, type Context } from "@neoworks/extension-system";
import type { ProfileRow } from "./rows";
import { loadProfile, type ProfileFiles } from "./sources";

declare module "@neoworks/extension-system" {
  interface Context {
    profile: ProfileService;
  }
}

export interface ProfileServiceConfig {
  /** The core layer of the profile. */
  coreRows: ProfileRow[];
  files: ProfileFiles;
}

export class ProfileService extends Service {
  static inject = ["loader"];

  private coreRows: ProfileRow[];
  private files: ProfileFiles;
  private folder: string | null = null;

  constructor(ctx: Context, config: ProfileServiceConfig) {
    super(ctx, "profile");
    this.coreRows = config.coreRows;
    this.files = config.files;
  }

  /** The folder whose profile is the project layer, or null when none is open. */
  projectFolder(): string | null {
    return this.folder;
  }

  /**
   * Reads every layer and applies the result. Resolves when the plugins have settled. Problems
   * with the files are logged and never stop the profile from applying.
   */
  async reload(): Promise<void> {
    const profile = await loadProfile(this.coreRows, this.files, this.folder);
    for (const problem of profile.problems) {
      this.ctx.logger.warn(problem);
    }
    await this.ctx.loader.apply(profile.rows);
  }

  /** Makes this folder's profile the project layer, or drops the layer for null, and reloads. */
  async setProjectFolder(folder: string | null): Promise<void> {
    if (folder === this.folder) {
      return;
    }
    this.folder = folder;
    await this.reload();
  }
}
