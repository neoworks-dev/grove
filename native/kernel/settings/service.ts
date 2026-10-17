// The `settings` service: what the settings page shows and changes. Each plugin declares its
// config as a schema (its `Config`), and this service lists the rows of the profile with the
// schema of the plugin each loads, reads their values from the layered profile, and writes
// changes into the user layer as minimal overrides. A change is then applied to the one row
// it touches: a plugin follows live fields on its own through `onLive`, and is unloaded and
// loaded again for anything else.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../reactive";
import {
  layerProfiles,
  userProfilePath,
  type LoadedProfile,
  type LoaderService,
  type PluginCatalog,
  type ProfileFiles,
  type ProfileLayer,
  type ProfileRow,
  type ResolvedRow,
  type RowReport,
  type RowStatus,
} from "../profile";
import { withEnabled, withFieldValue, type OverrideTarget } from "./overrides";
import {
  defaultsOf,
  describeFieldProblem,
  schemaOfPlugin,
  type EnumField,
  type EnumOption,
  type SettingValue,
  type SettingsSchema,
} from "./schema";

declare module "@neoworks/extension-system" {
  interface Context {
    settings: SettingsService;
  }
}

export interface SettingsOptions {
  /** The core plugins, whose `Config` schemas the settings describe. */
  catalog: PluginCatalog;
  files: ProfileFiles;
}

/** One row of the profile as the settings page shows it. */
export interface SettingsEntry {
  rowId: string;
  plugin: string;
  status: RowStatus;
  /** Why the row failed, or what it waits for. */
  message?: string;
  enabled: boolean;
  /** The app cannot run without this plugin, so the page does not offer to disable it. */
  essential: boolean;
  /** The plugin's fields; undefined when it has no settings. */
  schema: SettingsSchema | undefined;
  /** Every field's current value, defaults filled in. */
  values: Record<string, unknown>;
  /** The fields the user layer sets. */
  overridden: string[];
}

/** What a live handler is told when fields of its plugin's row change. */
export interface LiveChange {
  rowId: string;
  /** The row's whole config as the plugin would receive it now, defaults filled in. */
  config: Record<string, unknown>;
  /** The fields whose value changed. */
  changed: string[];
}

type RowChange = "none" | "live" | "restart";

interface LiveSubscription {
  pluginName: string;
  handler: (change: LiveChange) => void;
}

export class SettingsService extends Service {
  static inject = ["loader"];

  private catalog: PluginCatalog;
  private files: ProfileFiles;
  private loader: LoaderService;
  private coreLayer: ProfileLayer = { name: "core", rows: [] };
  private projectLayer: ProfileLayer | undefined;
  private userRows: ProfileRow[] = [];
  private userProblems: string[] = [];
  private rows: ResolvedRow[] = [];
  private liveSubscriptions: LiveSubscription[] = [];
  private optionLists = new Map<string, () => EnumOption[]>();
  private queue: Promise<void> = Promise.resolve();
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context, options: SettingsOptions) {
    super(ctx, "settings");
    this.catalog = options.catalog;
    this.files = options.files;
    this.loader = ctx.loader;
  }

  /**
   * Takes the layers of a freshly read profile, which the profile service hands over at boot
   * and again whenever the project folder changes. The settings entries follow at once.
   */
  setProfile(profile: LoadedProfile): void {
    this.coreLayer = profile.layers[0];
    this.projectLayer = profile.layers.find((layer) => layer.name === "project");
    const userLayer = profile.layers.find((layer) => layer.name === "user");
    this.userRows = [];
    if (userLayer) {
      this.userRows = userLayer.rows;
    }
    this.userProblems = profile.userProblems;
    this.rows = profile.rows;
    this.changes.notify();
  }

  /** The rows of the profile with their schemas and values, in profile order. Reactive. */
  entries(): SettingsEntry[] {
    this.changes.track();
    const reports = new Map<string, RowReport>(this.loader.reports().map((report) => [report.id, report]));
    return this.rows.map((row) => this.entryFor(row, reports.get(row.id)));
  }

  /** The schema of a core plugin, or undefined when it declares none. */
  schemaOf(pluginKey: string): SettingsSchema | undefined {
    return schemaOfPlugin(this.catalog[pluginKey]);
  }

  /** The id of the first profile row that loads a plugin, or undefined when none does. Reactive. */
  rowIdOf(pluginKey: string): string | undefined {
    this.changes.track();
    return this.rows.find((row) => row.plugin === pluginKey)?.id;
  }

  /** Sets one config field of a row in the user profile and applies it. Rejects with the reason a value is refused. */
  set(rowId: string, field: string, value: SettingValue): Promise<void> {
    const target = this.targetFor(rowId);
    const schemaField = target.fields?.[field];
    if (!schemaField) {
      return Promise.reject(new Error(`"${target.plugin}" has no setting named "${field}"`));
    }
    const problem = describeFieldProblem(schemaField, value);
    if (problem !== null) {
      return Promise.reject(new Error(`${schemaField.label} ${problem}`));
    }
    return this.commit((userRows) => withFieldValue(userRows, target, field, value));
  }

  /** Takes a field back to what core and the schema give, by removing its override. */
  reset(rowId: string, field: string): Promise<void> {
    const target = this.targetFor(rowId);
    return this.commit((userRows) => withFieldValue(userRows, target, field, undefined));
  }

  /** Enables or disables a row's plugin in the user profile; a disabled plugin is unloaded. */
  setEnabled(rowId: string, enabled: boolean): Promise<void> {
    const target = this.targetFor(rowId);
    return this.commit((userRows) => withEnabled(userRows, target, enabled));
  }

  /**
   * Calls `handler` when live fields of the calling plugin's row change, in place of the plugin
   * being unloaded and loaded again. Leaves with the calling plugin.
   */
  onLive(handler: (change: LiveChange) => void): () => void {
    const subscription: LiveSubscription = { pluginName: this.ctx.fiber.name, handler };
    return this.ctx.effect(() => {
      this.liveSubscriptions = [...this.liveSubscriptions, subscription];
      return () => {
        this.liveSubscriptions = this.liveSubscriptions.filter((existing) => existing !== subscription);
      };
    }, "settings.onLive()");
  }

  /** Supplies the choices of enum fields that name this list. Leaves with the calling plugin. */
  registerOptions(name: string, provider: () => EnumOption[]): () => void {
    return this.ctx.effect(() => {
      this.optionLists.set(name, provider);
      this.changes.notify();
      return () => {
        if (this.optionLists.get(name) === provider) {
          this.optionLists.delete(name);
        }
        this.changes.notify();
      };
    }, `settings.registerOptions(${name})`);
  }

  /** The choices of an enum field, whether it lists them or names a list a plugin supplies. Reactive. */
  optionsOf(field: EnumField): EnumOption[] {
    if (typeof field.options !== "string") {
      return field.options;
    }
    this.changes.track();
    const provider = this.optionLists.get(field.options);
    if (!provider) {
      return [];
    }
    return provider();
  }

  /** The row as the page shows it. */
  private entryFor(row: ResolvedRow, report: RowReport | undefined): SettingsEntry {
    const schema = this.schemaOf(row.plugin);
    const config = configObject(row.config);
    let values: Record<string, unknown> = { ...config };
    if (schema) {
      values = { ...defaultsOf(schema.fields), ...config };
    }
    const userConfig = configObject(this.userRows.find((userRow) => userRow.id === row.id)?.config);
    let status: RowStatus = "loading";
    if (report) {
      status = report.status;
    }
    return {
      rowId: row.id,
      plugin: row.plugin,
      status,
      message: report?.message,
      enabled: !row.disabled,
      essential: isEssential(this.catalog[row.plugin]),
      schema,
      values,
      overridden: Object.keys(userConfig),
    };
  }

  /** What an override of this row is measured against: the core layer's row and the plugin's fields. */
  private targetFor(rowId: string): OverrideTarget {
    const row = this.rows.find((candidate) => candidate.id === rowId);
    if (!row) {
      throw new Error(`no profile row "${rowId}"`);
    }
    const coreRow = layerProfiles([this.coreLayer]).rows.find((candidate) => candidate.id === rowId);
    return { rowId, plugin: row.plugin, coreRow, fields: this.schemaOf(row.plugin)?.fields };
  }

  /** Runs a change to the user rows after the ones before it: write the file, re-layer, apply. */
  private commit(change: (userRows: ProfileRow[]) => ProfileRow[]): Promise<void> {
    const done = this.queue.then(() => this.performCommit(change));
    this.queue = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  }

  private async performCommit(change: (userRows: ProfileRow[]) => ProfileRow[]): Promise<void> {
    if (this.userProblems.length > 0) {
      throw new Error(`the user profile has problems and is left alone: ${this.userProblems[0]}`);
    }
    const nextUserRows = change(this.userRows);
    const directory = await this.files.configDirectory();
    await this.files.writeText(userProfilePath(directory), `${JSON.stringify(nextUserRows, null, 2)}\n`);
    this.userRows = nextUserRows;
    const before = this.rows;
    this.rows = this.layeredRows();
    this.changes.notify();
    await this.applyDifferences(before, this.rows);
  }

  /** The profile's rows with the current user layer in place. */
  private layeredRows(): ResolvedRow[] {
    const layers: ProfileLayer[] = [this.coreLayer, { name: "user", rows: this.userRows }];
    if (this.projectLayer) {
      layers.push(this.projectLayer);
    }
    return layerProfiles(layers).rows;
  }

  /** Brings the loaded plugins in line with the new rows, touching only the rows that changed. */
  private async applyDifferences(before: ResolvedRow[], after: ResolvedRow[]): Promise<void> {
    let needsApply = before.length !== after.length;
    for (const row of after) {
      const kind = this.classifyChange(before.find((candidate) => candidate.id === row.id), row);
      if (kind === "live") {
        this.followLive(before.find((candidate) => candidate.id === row.id)!, row);
      }
      if (kind === "restart") {
        needsApply = true;
      }
    }
    if (needsApply) {
      await this.loader.apply(after);
    }
  }

  /** Whether a row's change needs its plugin mounted again, can be followed live, or is nothing. */
  private classifyChange(before: ResolvedRow | undefined, after: ResolvedRow): RowChange {
    if (!before || before.plugin !== after.plugin || before.disabled !== after.disabled) {
      return "restart";
    }
    const changed = changedFields(before, after);
    if (changed.length === 0) {
      return "none";
    }
    const schema = this.schemaOf(after.plugin);
    if (!schema || after.disabled || !this.loader.isMounted(after.id)) {
      return "restart";
    }
    if (changed.every((field) => schema.fields[field]?.live === true)) {
      return "live";
    }
    return "restart";
  }

  /** Keeps the plugin mounted and tells its live handlers what changed. */
  private followLive(before: ResolvedRow, after: ResolvedRow): void {
    this.loader.retarget(after);
    const schema = this.schemaOf(after.plugin)!;
    const validated = schema["~standard"].validate(after.config);
    if (validated instanceof Promise || validated.issues) {
      return;
    }
    const change: LiveChange = {
      rowId: after.id,
      config: validated.value as Record<string, unknown>,
      changed: changedFields(before, after),
    };
    const pluginName = nameOfPlugin(this.catalog[after.plugin], after.plugin);
    for (const subscription of this.liveSubscriptions) {
      if (subscription.pluginName === pluginName) {
        this.callLiveHandler(subscription, change);
      }
    }
  }

  private callLiveHandler(subscription: LiveSubscription, change: LiveChange): void {
    try {
      subscription.handler(change);
    } catch (error) {
      this.ctx.logger.error(error);
    }
  }
}

/** A row's config as an object; anything else counts as no config. */
function configObject(config: unknown): Record<string, unknown> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return {};
  }
  return config as Record<string, unknown>;
}

/** The config keys whose value differs between two versions of a row. */
function changedFields(before: ResolvedRow, after: ResolvedRow): string[] {
  const earlier = configObject(before.config);
  const later = configObject(after.config);
  const names = new Set([...Object.keys(earlier), ...Object.keys(later)]);
  return [...names].filter((name) => JSON.stringify(earlier[name]) !== JSON.stringify(later[name]));
}

/** Whether a plugin object marks itself as one the app cannot run without. */
function isEssential(plugin: unknown): boolean {
  if (typeof plugin !== "object" || plugin === null) {
    return false;
  }
  return (plugin as { essential?: unknown }).essential === true;
}

/** The name a plugin runs under, which handlers registered from it are filed by. */
function nameOfPlugin(plugin: unknown, catalogKey: string): string {
  if (typeof plugin === "object" && plugin !== null) {
    const name = (plugin as { name?: unknown }).name;
    if (typeof name === "string") {
      return name;
    }
  }
  return catalogKey;
}

