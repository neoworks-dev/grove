// A profile is a list of rows, each naming a plugin to load. Rows come in layers, core then
// user then project, and a later layer's row replaces the earlier row with the same id. Pure
// functions, so layering is testable without files or a window.

export interface ProfileRow {
  /** Names the row across layers: a later layer's row with this id replaces the earlier one. */
  id: string;
  /** The core plugin to load. A disabled row may leave it out and keeps the replaced row's. */
  plugin?: string;
  /** Handed to the plugin as its config. */
  config?: unknown;
  /** Keeps the row in the profile but does not load it. */
  disabled?: boolean;
}

export interface ProfileLayer {
  name: string;
  rows: ProfileRow[];
}

/** A row after layering: always names a plugin and says which layer it came from. */
export interface ResolvedRow {
  id: string;
  plugin: string;
  config?: unknown;
  disabled: boolean;
  layer: string;
}

export interface ParsedProfile {
  rows: ProfileRow[];
  /** What was wrong with the file or with single rows, for the log. */
  problems: string[];
}

/** Reads a profile file: a JSON array of rows. Rows that are not objects with a string id are skipped. */
export function parseProfile(text: string, source: string): ParsedProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { rows: [], problems: [`${source}: not valid JSON (${describeError(error)})`] };
  }
  if (!Array.isArray(parsed)) {
    return { rows: [], problems: [`${source}: expected a JSON array of rows`] };
  }
  const rows: ProfileRow[] = [];
  const problems: string[] = [];
  parsed.forEach((value, index) => {
    const problem = describeRowProblem(value);
    if (problem) {
      problems.push(`${source}: row ${index} ${problem}`);
      return;
    }
    rows.push(value as ProfileRow);
  });
  return { rows, problems };
}

/**
 * Stacks the layers into one list of rows. A row keeps the position of the first layer that
 * had its id. What a later layer's row leaves out it inherits from the row it replaces: the
 * plugin, the disabled flag, and each config key it does not set (config objects merge one
 * level deep). A row that names no plugin and replaces none is dropped with a problem.
 */
export function layerProfiles(layers: ProfileLayer[]): { rows: ResolvedRow[]; problems: string[] } {
  const byId = new Map<string, ResolvedRow>();
  const problems: string[] = [];
  for (const layer of layers) {
    for (const row of layer.rows) {
      const resolved = resolveRow(row, byId.get(row.id), layer.name);
      if (typeof resolved === "string") {
        problems.push(`${layer.name}: row "${row.id}" ${resolved}`);
        continue;
      }
      byId.set(row.id, resolved);
    }
  }
  return { rows: [...byId.values()], problems };
}

/** One row on top of the row it replaces, or the reason it cannot be resolved. */
function resolveRow(row: ProfileRow, replaced: ResolvedRow | undefined, layer: string): ResolvedRow | string {
  let plugin = row.plugin;
  if (plugin === undefined && replaced) {
    plugin = replaced.plugin;
  }
  if (plugin === undefined) {
    return "names no plugin";
  }
  let disabled = row.disabled;
  if (disabled === undefined) {
    disabled = replaced !== undefined && replaced.disabled;
  }
  let replacedConfig: unknown;
  if (replaced && replaced.plugin === plugin) {
    replacedConfig = replaced.config;
  }
  return { id: row.id, plugin, config: mergeConfig(replacedConfig, row.config), disabled, layer };
}

/** A later config on top of an earlier one: plain objects merge key by key, anything else replaces. */
function mergeConfig(earlier: unknown, later: unknown): unknown {
  if (later === undefined) {
    return earlier;
  }
  if (isPlainObject(earlier) && isPlainObject(later)) {
    return { ...earlier, ...later };
  }
  return later;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why a value cannot be a row, or null when it can. */
function describeRowProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "is not an object";
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id === "") {
    return "has no id";
  }
  if (row.plugin !== undefined && typeof row.plugin !== "string") {
    return `("${row.id}") has a plugin that is not a string`;
  }
  if (row.disabled !== undefined && typeof row.disabled !== "boolean") {
    return `("${row.id}") has a disabled that is not true or false`;
  }
  return null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
