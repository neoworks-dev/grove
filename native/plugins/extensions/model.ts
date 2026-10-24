// What the extensions view lists, worked out from the installed extensions, the search results
// and what is being done to which package. Plain data and plain functions, so the view only draws.

import type { InstalledExtension, RegistryPackage } from "../../kernel/extensions";
import { isNewer } from "../../kernel/extensions";
import type { SettingField, SettingsEntry } from "../../kernel/settings";

/** What is being done to a package right now. */
export type Activity = "installing" | "updating" | "removing";

/** The settings of one plugin of an extension, as the form under its row shows them. */
export interface SettingsSection {
  rowId: string;
  /** What the form calls the plugin: its title in the manifest, or "Settings" for the settings the manifest declares itself. */
  title: string;
  /** Why the plugin did not load, when it did not; its settings are still listed so they can be fixed. */
  failure: string | null;
  fields: [string, SettingField][];
  values: Record<string, unknown>;
  overridden: string[];
}

export interface InstalledRow {
  kind: "installed";
  name: string;
  title: string;
  version: string;
  description: string;
  enabled: boolean;
  /** What is wrong with the package, which the row shows in place of its description. */
  problem: string | null;
  /** The newer version the registry has, when it has one. */
  update: string | null;
  activity: Activity | null;
  /** The plugins of the extension that have settings, or have failed. */
  sections: SettingsSection[];
  /** How many settings the extension has in all, which decides whether its row offers a form. */
  settingCount: number;
  settingsOpen: boolean;
}

export interface ResultRow {
  kind: "result";
  name: string;
  version: string;
  description: string;
  publisher: string;
  installed: boolean;
  activity: Activity | null;
}

export interface HeadingRow {
  kind: "heading";
  title: string;
}

/** A line of explanation where a section has nothing to list. */
export interface MessageRow {
  kind: "message";
  text: string;
  tone: "quiet" | "bad";
}

export type ViewRow = InstalledRow | ResultRow | HeadingRow | MessageRow;

export type SearchState = "idle" | "searching" | "failed";

export interface ViewInputs {
  installed: InstalledExtension[];
  results: RegistryPackage[];
  searchState: SearchState;
  searchError: string | null;
  /** The newest version the registry has, by package, for the packages that were checked. */
  latest: ReadonlyMap<string, string>;
  activity: ReadonlyMap<string, Activity>;
  /** The profile's rows with their settings, from which an extension's plugins are picked. */
  settings: SettingsEntry[];
  /** The extension whose settings form is open, if one is. */
  openSettings: string | null;
}

/** The rows of the view, top to bottom: the installed extensions, then what a search found. */
export function buildRows(inputs: ViewInputs): ViewRow[] {
  const rows: ViewRow[] = [{ kind: "heading", title: `Your extensions (${inputs.installed.length})` }];
  if (inputs.installed.length === 0) {
    rows.push({ kind: "message", text: "No extensions are installed.", tone: "quiet" });
  }
  for (const extension of inputs.installed) {
    rows.push(installedRow(extension, inputs));
  }
  rows.push({ kind: "heading", title: "On npm" });
  rows.push(...searchRows(inputs));
  return rows;
}

/** The row for one installed extension. */
function installedRow(extension: InstalledExtension, inputs: ViewInputs): InstalledRow {
  const manifest = extension.manifest;
  let title = extension.name;
  let description = "";
  if (manifest !== null) {
    title = manifest.title;
    description = manifest.description;
  }
  let update: string | null = null;
  const latest = inputs.latest.get(extension.name);
  if (latest !== undefined && isNewer(latest, extension.version)) {
    update = latest;
  }
  let problem: string | null = null;
  if (manifest === null || extension.problems.length > 0) {
    problem = extension.problems[0];
  }
  const sections = settingsSectionsOf(extension, inputs.settings);
  return {
    kind: "installed",
    name: extension.name,
    title,
    version: extension.version,
    description,
    enabled: extension.enabled,
    problem,
    update,
    activity: activityOf(inputs, extension.name),
    sections,
    settingCount: sections.reduce((total, section) => total + section.fields.length, 0),
    settingsOpen: inputs.openSettings === extension.name,
  };
}

/**
 * The plugins of an extension that have something to configure. They are the extension's profile
 * rows (`<package>:<id>`), so what is shown and saved is what the settings page shows and saves.
 */
export function settingsSectionsOf(extension: InstalledExtension, entries: SettingsEntry[]): SettingsSection[] {
  const prefix = `${extension.name}:`;
  const sections: SettingsSection[] = [];
  for (const entry of entries) {
    if (!entry.rowId.startsWith(prefix)) {
      continue;
    }
    let fields: [string, SettingField][] = [];
    if (entry.schema !== undefined) {
      fields = Object.entries(entry.schema.fields);
    }
    if (fields.length === 0 && entry.status !== "failed") {
      continue;
    }
    sections.push({
      rowId: entry.rowId,
      title: sectionTitle(extension, entry.rowId.slice(prefix.length)),
      failure: failureOf(entry),
      fields,
      values: entry.values,
      overridden: entry.overridden,
    });
  }
  return sections;
}

/** What a plugin's form is called: its title, else its id. */
function sectionTitle(extension: InstalledExtension, pluginId: string): string {
  if (pluginId === "settings") {
    return "Settings";
  }
  const plugin = extension.manifest?.plugins.find((candidate) => candidate.id === pluginId);
  if (plugin !== undefined && plugin.title !== undefined) {
    return plugin.title;
  }
  return pluginId;
}

/** Why a plugin is not running, or null when it is, or is only switched off. */
function failureOf(entry: SettingsEntry): string | null {
  if (entry.status !== "failed") {
    return null;
  }
  if (entry.message === undefined) {
    return "The plugin failed to load.";
  }
  return entry.message;
}

/** The rows under the "On npm" heading. */
function searchRows(inputs: ViewInputs): ViewRow[] {
  if (inputs.searchState === "failed" && inputs.searchError !== null) {
    return [{ kind: "message", text: inputs.searchError, tone: "bad" }];
  }
  if (inputs.searchState === "searching" && inputs.results.length === 0) {
    return [{ kind: "message", text: "Searching npm…", tone: "quiet" }];
  }
  if (inputs.results.length === 0) {
    return [{ kind: "message", text: "No extensions found.", tone: "quiet" }];
  }
  const installedNames = new Set(inputs.installed.map((extension) => extension.name));
  return inputs.results.map((result) => ({
    kind: "result",
    name: result.name,
    version: result.version,
    description: result.description,
    publisher: result.publisher,
    installed: installedNames.has(result.name),
    activity: activityOf(inputs, result.name),
  }));
}

/** What is being done to a package, or null. */
function activityOf(inputs: ViewInputs, name: string): Activity | null {
  const activity = inputs.activity.get(name);
  if (activity === undefined) {
    return null;
  }
  return activity;
}
