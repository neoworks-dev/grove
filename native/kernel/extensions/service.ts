// The `extensions` service: finds the installed extensions, evaluates their plugins, puts them
// in the plugin catalog under `<package>:<id>` and hands the profile one row per plugin. From
// there an extension plugin is an ordinary row: the user's profile can configure or disable it,
// the settings page lists it, and the loader reports how it went. Extensions the user switched
// off contribute nothing, and are not even read beyond their manifest.

import { Service, type Context, type Plugin } from "@neoworks/extension-system";
import type { PluginCatalog, ProfileRow } from "../profile";
import { createChangeSignal, type ChangeSignal } from "../reactive";
import { defineSettings } from "../settings";
import { contributionsOf, type ToolsHost } from "./contributions";
import { evaluateExtensionScript, type SharedModules } from "./evaluate";
import type {
  ExtensionManifest,
  GrammarContribution,
  LanguageServerContribution,
  ThemeContribution,
  ToolContribution,
} from "./manifest";
import {
  directoryNameOf,
  extensionsDirectory,
  readDisabled,
  readInstalled,
  statePath,
  stateText,
  type ExtensionFiles,
  type InstalledExtension,
  type TarballHashes,
} from "./store";

declare module "@neoworks/extension-system" {
  interface Context {
    extensions: ExtensionsService;
  }
}

export interface ExtensionsConfig {
  /** The plugin catalog the loader mounts from; extension plugins are added to it and taken out again. */
  catalog: PluginCatalog;
  /** Where extensions are read from; null when the app has no place to install them. */
  files: ExtensionFiles | null;
  /** What scripts may `require`. */
  modules: SharedModules;
  /** Where the language servers and tools extensions contribute are handed to; null when the app has none. */
  tools?: ToolsHost | null;
}

/** A part an extension contributes, with the extension it came from. */
export type Contributed<Part> = Part & { extension: string; directory: string };

export class ExtensionsService extends Service {
  private catalog: PluginCatalog;
  private files: ExtensionFiles | null;
  private modules: SharedModules;
  private toolsHost: ToolsHost | null = null;
  private installedList: InstalledExtension[] = [];
  private rowList: ProfileRow[] = [];
  private catalogKeys = new Set<string>();
  /** Evaluated plugins by extension, version and script, so a profile reload keeps them mounted. */
  private evaluated = new Map<string, EvaluatedPlugin>();
  private settingValues = new Map<string, Record<string, unknown>>();
  private applier: (() => Promise<void>) | null = null;
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context, config: ExtensionsConfig) {
    super(ctx, "extensions");
    this.catalog = config.catalog;
    this.files = config.files;
    this.modules = config.modules;
    if (config.tools !== undefined) {
      this.toolsHost = config.tools;
    }
  }

  /**
   * Reads the installed extensions again, evaluates the plugins of the ones that are enabled and
   * makes the catalog and `rows()` match. A script that fails becomes a plugin that fails with
   * the reason, so the loader reports it like any other failed row.
   */
  async refresh(): Promise<void> {
    this.removeCatalogEntries();
    if (this.files === null) {
      this.installedList = [];
      this.rowList = [];
      this.changes.notify();
      return;
    }
    const installed = await readInstalled(this.files);
    const rows: ProfileRow[] = [];
    for (const extension of installed) {
      if (extension.enabled && extension.manifest !== null) {
        rows.push(...(await this.contribute(extension, extension.manifest)));
      }
    }
    this.installedList = installed;
    this.rowList = rows;
    for (const extension of installed) {
      for (const problem of extension.problems) {
        this.ctx.logger.warn(problem);
      }
    }
    await this.registerWithHost(installed);
    this.changes.notify();
  }

  /** Tells the host which language servers and tools the enabled extensions bring. A host that fails to take them is logged, and the plugins are not held up. */
  private async registerWithHost(installed: InstalledExtension[]): Promise<void> {
    if (this.toolsHost === null) {
      return;
    }
    try {
      await this.toolsHost.registerContributions(contributionsOf(installed));
    } catch (error) {
      this.ctx.logger.warn(`could not hand the extensions' tools to the host: ${describeError(error)}`);
    }
  }

  /** The profile rows of the enabled extensions' plugins, ready to be a layer of the profile. */
  rows(): ProfileRow[] {
    return this.rowList;
  }

  /** Every extension found on disk, usable or not. Reactive. */
  installed(): InstalledExtension[] {
    this.changes.track();
    return this.installedList;
  }

  /** The grammars of the enabled extensions. Reactive. */
  grammars(): Contributed<GrammarContribution>[] {
    return this.contributions((manifest) => manifest.grammars);
  }

  /** The language servers of the enabled extensions. Reactive. */
  languageServers(): Contributed<LanguageServerContribution>[] {
    return this.contributions((manifest) => manifest.languageServers);
  }

  /** The tools of the enabled extensions. Reactive. */
  tools(): Contributed<ToolContribution>[] {
    return this.contributions((manifest) => manifest.tools);
  }

  /** The themes of the enabled extensions. Reactive. */
  themes(): Contributed<ThemeContribution>[] {
    return this.contributions((manifest) => manifest.themes);
  }

  /** The current values of the settings an extension declared without a plugin, or undefined before they are applied. */
  settingsOf(extensionName: string): Record<string, unknown> | undefined {
    this.changes.track();
    return this.settingValues.get(extensionName);
  }

  /** Switches an extension on or off, remembers it, and has the profile reload so its plugins mount or unmount. */
  async setEnabled(extensionName: string, enabled: boolean): Promise<void> {
    const files = this.requireFiles();
    const disabled = (await readDisabled(files)).filter((name) => name !== extensionName);
    if (!enabled) {
      disabled.push(extensionName);
    }
    const data = await files.dataDirectory();
    await files.writeText(statePath(data), stateText(disabled));
    await this.reloadAll();
  }

  /** The extension files, or a thrown sentence when the app has nowhere to keep extensions. */
  private requireFiles(): ExtensionFiles {
    if (this.files === null) {
      throw new Error("this app has nowhere to keep extensions");
    }
    return this.files;
  }

  /**
   * Installs an extension from its tarball, or replaces an installed one with it, and has the
   * profile reload so a new plugin mounts and an updated one is mounted again. An update keeps the
   * extension switched on or off as it was. Resolves with the version now installed.
   */
  async installPackage(name: string, tarball: ArrayBuffer, hashes: TarballHashes): Promise<string> {
    const files = this.requireFiles();
    const data = await files.dataDirectory();
    const directory = `${extensionsDirectory(data)}/${directoryNameOf(name)}`;
    const installed = await files.installTarball(directory, name, tarball, hashes);
    this.forget(name);
    await this.reloadAll();
    return installed.version;
  }

  /** Deletes an installed extension and what it contributed, and forgets that it was switched off. */
  async remove(name: string): Promise<void> {
    const files = this.requireFiles();
    const data = await files.dataDirectory();
    await files.removeDirectory(`${extensionsDirectory(data)}/${directoryNameOf(name)}`);
    const disabled = await readDisabled(files);
    if (disabled.includes(name)) {
      await files.writeText(statePath(data), stateText(disabled.filter((entry) => entry !== name)));
    }
    this.forget(name);
    await this.reloadAll();
  }

  /** Forgets the evaluated scripts of an extension, so the next refresh reads them from disk again. */
  forget(extensionName: string): void {
    for (const key of [...this.evaluated.keys()]) {
      if (key.startsWith(`${extensionName}@`)) {
        this.evaluated.delete(key);
      }
    }
  }

  /**
   * Sets what makes everything take effect after a change: the profile service gives its
   * `reload`. Without one, a change only refreshes this service.
   */
  setApplier(applier: () => Promise<void>): void {
    this.applier = applier;
  }

  /** Re-reads extensions and applies the result to the plugins that are mounted. */
  async reloadAll(): Promise<void> {
    if (this.applier !== null) {
      await this.applier();
      return;
    }
    await this.refresh();
  }

  /** Records the values of an extension's settings; called by the plugin that carries them. */
  noteSettings(extensionName: string, values: Record<string, unknown>): void {
    this.settingValues.set(extensionName, values);
    this.changes.notify();
  }

  /** Takes an extension's setting values away when their plugin unloads. */
  forgetSettings(extensionName: string): void {
    this.settingValues.delete(extensionName);
    this.changes.notify();
  }

  /** The parts of one kind from every enabled extension. */
  private contributions<Part>(pick: (manifest: ExtensionManifest) => Part[]): Contributed<Part>[] {
    this.changes.track();
    const parts: Contributed<Part>[] = [];
    for (const extension of this.installedList) {
      if (extension.enabled && extension.manifest !== null) {
        for (const part of pick(extension.manifest)) {
          parts.push({ ...part, extension: extension.name, directory: extension.directory });
        }
      }
    }
    return parts;
  }

  /** Takes the previous refresh's plugins out of the catalog. */
  private removeCatalogEntries(): void {
    for (const key of this.catalogKeys) {
      delete this.catalog[key];
    }
    this.catalogKeys.clear();
  }

  /** Adds everything one extension contributes to the catalog and returns its rows. */
  private async contribute(extension: InstalledExtension, manifest: ExtensionManifest): Promise<ProfileRow[]> {
    const rows: ProfileRow[] = [];
    for (const contribution of manifest.plugins) {
      const key = `${manifest.name}:${contribution.id}`;
      const plugin = await this.loadPlugin(extension, manifest, contribution.main, key);
      rows.push(this.addToCatalog(key, plugin));
    }
    if (manifest.themes.length > 0) {
      const key = `${manifest.name}:themes`;
      rows.push(this.addToCatalog(key, await this.themePlugin(extension, manifest, key)));
    }
    if (Object.keys(manifest.settings).length > 0) {
      const key = `${manifest.name}:settings`;
      rows.push(this.addToCatalog(key, settingsPlugin(manifest, key)));
    }
    return rows;
  }

  /** Puts a plugin in the catalog and returns the row that loads it. */
  private addToCatalog(key: string, plugin: Plugin): ProfileRow {
    this.catalog[key] = plugin;
    this.catalogKeys.add(key);
    return { id: key, plugin: key };
  }

  /** Reads and evaluates a plugin's script; a failure becomes a plugin that fails with the reason. */
  private async loadPlugin(
    extension: InstalledExtension,
    manifest: ExtensionManifest,
    main: string,
    key: string,
  ): Promise<Plugin> {
    const cacheKey = `${manifest.name}@${manifest.version}:${main}`;
    let entry = this.evaluated.get(cacheKey);
    if (entry === undefined) {
      entry = await this.evaluate(extension, manifest, main, key);
      this.evaluated.set(cacheKey, entry);
    }
    if (entry.failure !== undefined) {
      extension.problems.push(entry.failure);
    }
    return entry.plugin;
  }

  /** Runs one script, and keeps either the plugin or the reason it could not be made. */
  private async evaluate(
    extension: InstalledExtension,
    manifest: ExtensionManifest,
    main: string,
    key: string,
  ): Promise<EvaluatedPlugin> {
    try {
      const code = await this.files!.readIfExists(`${extension.directory}/${main}`);
      if (code === null) {
        throw new Error(`${main} does not exist in ${manifest.name}`);
      }
      const evaluated = evaluateExtensionScript(code, `${manifest.name}/${main}`, this.modules);
      return { plugin: { ...(evaluated as object), name: key } as Plugin };
    } catch (error) {
      const failure = describeError(error);
      return { plugin: failingPlugin(key, failure), failure };
    }
  }

  /** The plugin that registers an extension's themes with the theme service. */
  private async themePlugin(extension: InstalledExtension, manifest: ExtensionManifest, key: string): Promise<Plugin> {
    const themes: ThemeToRegister[] = [];
    for (const theme of manifest.themes) {
      try {
        themes.push(await this.readTheme(extension, manifest, theme));
      } catch (error) {
        extension.problems.push(describeError(error));
      }
    }
    return {
      name: key,
      inject: ["theme"],
      apply(ctx: Context) {
        for (const theme of themes) {
          ctx.theme.registerPartialTheme(theme);
        }
      },
    } as Plugin;
  }

  /** One theme with its tokens read from its file, if it has one. */
  private async readTheme(
    extension: InstalledExtension,
    manifest: ExtensionManifest,
    theme: ThemeContribution,
  ): Promise<ThemeToRegister> {
    let tokens: Record<string, string> = {};
    if (theme.tokens !== undefined) {
      tokens = theme.tokens;
    }
    if (theme.file !== undefined) {
      tokens = await this.readThemeFile(extension, theme.file);
    }
    return { id: `${manifest.name}:${theme.id}`, name: theme.name, scheme: theme.scheme, tokens };
  }

  /** The tokens in a theme file: its `tokens` object, or the whole file when it has none. */
  private async readThemeFile(extension: InstalledExtension, file: string): Promise<Record<string, string>> {
    const text = await this.files!.readIfExists(`${extension.directory}/${file}`);
    if (text === null) {
      throw new Error(`${file} does not exist in ${extension.name}`);
    }
    const parsed = JSON.parse(text) as { tokens?: Record<string, string> };
    if (parsed.tokens !== undefined) {
      return parsed.tokens;
    }
    return parsed as Record<string, string>;
  }
}

/** A script's outcome: the plugin, or a plugin that fails with the reason the script could not run. */
interface EvaluatedPlugin {
  plugin: Plugin;
  failure?: string;
}

interface ThemeToRegister {
  id: string;
  name: string;
  scheme: "dark" | "light";
  tokens: Record<string, string>;
}

/** A plugin that only carries settings an extension declared, so the settings page can show them. */
function settingsPlugin(manifest: ExtensionManifest, key: string): Plugin {
  const extensionName = manifest.name;
  return {
    name: key,
    Config: defineSettings(manifest.settings),
    inject: ["extensions"],
    apply(ctx: Context, config: Record<string, unknown>) {
      ctx.extensions.noteSettings(extensionName, config);
      ctx.effect(() => () => ctx.extensions.forgetSettings(extensionName), "extensions.settings");
    },
  } as Plugin;
}

/** A plugin that fails when it loads, so a script that could not be evaluated shows up as a failed row. */
function failingPlugin(key: string, message: string): Plugin {
  return {
    name: key,
    apply() {
      throw new Error(message);
    },
  } as Plugin;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
