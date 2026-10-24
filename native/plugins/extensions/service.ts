// The state behind the extensions view: the search, what is being installed, updated or removed,
// and which installed extensions have a newer version. A plain class with a change signal, like
// the kernel's services, so it runs under `bun test` with a fake registry.

import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { ExtensionsService, NpmRegistry, RegistryPackage } from "../../kernel/extensions";
import type { SettingsService } from "../../kernel/settings";
import { buildRows, type Activity, type SearchState, type ViewRow } from "./model";

export class ExtensionBrowser {
  private extensions: ExtensionsService;
  private registry: NpmRegistry;
  private settings: SettingsService;
  private openName: string | null = null;
  private foundList: RegistryPackage[] = [];
  private state: SearchState = "idle";
  private error: string | null = null;
  private searchCount = 0;
  private latestVersions = new Map<string, string>();
  private activities = new Map<string, Activity>();
  private message: string | null = null;
  private changes: ChangeSignal = createChangeSignal();

  constructor(extensions: ExtensionsService, registry: NpmRegistry, settings: SettingsService) {
    this.extensions = extensions;
    this.registry = registry;
    this.settings = settings;
  }

  /** The rows the view draws. Reactive. */
  rows(): ViewRow[] {
    this.changes.track();
    return buildRows({
      installed: this.extensions.installed(),
      results: this.foundList,
      searchState: this.state,
      searchError: this.error,
      latest: this.latestVersions,
      activity: this.activities,
      settings: this.settings.entries(),
      openSettings: this.openName,
    });
  }

  /** Opens an extension's settings form under its row, or closes it when it is the one open. */
  toggleSettings(name: string): void {
    if (this.openName === name) {
      this.openName = null;
    } else {
      this.openName = name;
    }
    this.changes.notify();
  }

  /** The last failure of an install, update or removal, until it is dismissed. Reactive. */
  notice(): string | null {
    this.changes.track();
    return this.message;
  }

  /** Hides the notice. */
  clearNotice(): void {
    this.message = null;
    this.changes.notify();
  }

  /**
   * Searches npm for extensions matching the text, or lists them all for an empty text. A search
   * that is overtaken by a newer one is dropped, so a slow answer never replaces a fresh one.
   */
  async search(text: string): Promise<void> {
    const ticket = ++this.searchCount;
    this.state = "searching";
    this.error = null;
    this.changes.notify();
    try {
      const found = await this.registry.search(text.trim());
      if (ticket !== this.searchCount) {
        return;
      }
      this.foundList = found;
      this.state = "idle";
    } catch (error) {
      if (ticket !== this.searchCount) {
        return;
      }
      this.foundList = [];
      this.state = "failed";
      this.error = describeError(error);
    }
    this.changes.notify();
  }

  /** Installs the newest version of a package from the registry. */
  install(name: string): Promise<void> {
    return this.change(name, "installing", () => this.fetchAndInstall(name));
  }

  /** Replaces an installed extension with the newest version. */
  update(name: string): Promise<void> {
    return this.change(name, "updating", () => this.fetchAndInstall(name));
  }

  /** Deletes an installed extension. */
  remove(name: string): Promise<void> {
    return this.change(name, "removing", () => this.extensions.remove(name));
  }

  /** Switches an installed extension on or off. */
  setEnabled(name: string, enabled: boolean): Promise<void> {
    return this.change(name, null, () => this.extensions.setEnabled(name, enabled));
  }

  /** Asks the registry for the newest version of every installed extension, to offer updates. */
  async checkForUpdates(): Promise<void> {
    for (const extension of this.extensions.installed()) {
      if (extension.manifest === null) {
        continue;
      }
      try {
        const latest = await this.registry.resolve(extension.name);
        this.latestVersions.set(extension.name, latest.version);
      } catch {
        // A package that is not on this registry has nothing to update to.
        this.latestVersions.delete(extension.name);
      }
    }
    this.changes.notify();
  }

  /** Looks the package up, downloads its tarball and installs it. */
  private async fetchAndInstall(name: string): Promise<void> {
    const release = await this.registry.resolve(name);
    const tarball = await this.registry.download(release);
    const version = await this.extensions.installPackage(name, tarball, {
      integrity: release.integrity,
      shasum: release.shasum,
    });
    this.latestVersions.set(name, version);
  }

  /** Runs one change to a package, shows it as busy meanwhile, and reports a failure as the notice. */
  private async change(name: string, activity: Activity | null, task: () => Promise<void>): Promise<void> {
    if (this.activities.has(name)) {
      return;
    }
    if (activity !== null) {
      this.activities.set(name, activity);
    }
    this.message = null;
    this.changes.notify();
    try {
      await task();
    } catch (error) {
      this.message = `${name}: ${describeError(error)}`;
    }
    this.activities.delete(name);
    this.changes.notify();
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
