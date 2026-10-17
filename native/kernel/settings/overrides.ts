// Turning a change in the settings page into rows of the user's profile. The user layer holds
// only what differs from the core layer under it: a row exists when it changes something, its
// config holds only the keys whose value is not what core and the schema already give, and
// `disabled` is written only when it flips the core row. Pure functions over rows, so the
// diff is testable without files.

import type { ProfileRow, ResolvedRow } from "../profile";
import { defaultsOf, type SettingFields, type SettingValue } from "./schema";

export interface OverrideTarget {
  /** The row being changed. */
  rowId: string;
  /** The plugin the row loads, written into a row that exists only in the user layer. */
  plugin: string;
  /** The row as the core layer alone resolves it, or undefined when core has no such row. */
  coreRow: ResolvedRow | undefined;
  /** The plugin's fields, for the defaults a value is compared against; undefined without a schema. */
  fields: SettingFields | undefined;
}

/** The user rows with one config field set to `value`, or put back to what the layers below give. */
export function withFieldValue(
  userRows: ProfileRow[],
  target: OverrideTarget,
  field: string,
  value: SettingValue | undefined,
): ProfileRow[] {
  const row = findOrStartRow(userRows, target);
  const config = { ...configOf(row) };
  if (value === undefined) {
    delete config[field];
  } else {
    config[field] = value;
  }
  return replaceRow(userRows, target, { ...row, config });
}

/** The user rows with a plugin enabled or disabled. */
export function withEnabled(userRows: ProfileRow[], target: OverrideTarget, enabled: boolean): ProfileRow[] {
  const row = findOrStartRow(userRows, target);
  return replaceRow(userRows, target, { ...row, disabled: !enabled });
}

/** What a field has without any user override: core's value, else the schema's default. */
export function baseValueOf(target: OverrideTarget, field: string): SettingValue | undefined {
  const coreConfig = configOf(target.coreRow);
  const coreValue = coreConfig[field];
  if (coreValue !== undefined) {
    return coreValue as SettingValue;
  }
  if (!target.fields) {
    return undefined;
  }
  return defaultsOf(target.fields)[field];
}

/** The row's own config object, or an empty one. */
function configOf(row: { config?: unknown } | undefined): Record<string, unknown> {
  if (!row || typeof row.config !== "object" || row.config === null || Array.isArray(row.config)) {
    return {};
  }
  return row.config as Record<string, unknown>;
}

/** The user's row for the target, or a bare one to build on. */
function findOrStartRow(userRows: ProfileRow[], target: OverrideTarget): ProfileRow {
  const existing = userRows.find((row) => row.id === target.rowId);
  if (existing) {
    return existing;
  }
  return { id: target.rowId };
}

/** Puts the row back among the user rows, trimmed to what differs, or removes it when nothing does. */
function replaceRow(userRows: ProfileRow[], target: OverrideTarget, row: ProfileRow): ProfileRow[] {
  const trimmed = trimToDifferences(row, target);
  const index = userRows.findIndex((existing) => existing.id === target.rowId);
  if (trimmed === null) {
    return userRows.filter((existing) => existing.id !== target.rowId);
  }
  if (index < 0) {
    return [...userRows, trimmed];
  }
  return userRows.map((existing, position) => {
    if (position === index) {
      return trimmed;
    }
    return existing;
  });
}

/** The row without anything the layers below already say, or null when that leaves nothing to say. */
function trimToDifferences(row: ProfileRow, target: OverrideTarget): ProfileRow | null {
  if (!target.coreRow) {
    // A row core does not have is defined here, so it keeps its plugin and everything it says.
    return withoutEmptyConfig({ ...row, plugin: target.plugin }, target);
  }
  const trimmed: ProfileRow = { id: row.id };
  if (row.plugin !== undefined && row.plugin !== target.coreRow.plugin) {
    trimmed.plugin = row.plugin;
  }
  if (row.disabled !== undefined && row.disabled !== target.coreRow.disabled) {
    trimmed.disabled = row.disabled;
  }
  const config = differingConfig(configOf(row), target);
  if (Object.keys(config).length > 0) {
    trimmed.config = config;
  }
  if (Object.keys(trimmed).length === 1) {
    return null;
  }
  return trimmed;
}

/** A user-only row with an empty config object dropped. */
function withoutEmptyConfig(row: ProfileRow, target: OverrideTarget): ProfileRow {
  const config = differingConfig(configOf(row), target);
  const { config: _dropped, ...rest } = row;
  if (Object.keys(config).length === 0) {
    return rest;
  }
  return { ...rest, config };
}

/** The config keys whose value differs from what core and the schema give. */
function differingConfig(config: Record<string, unknown>, target: OverrideTarget): Record<string, unknown> {
  const differing: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(config)) {
    if (!sameValue(value, baseValueOf(target, field))) {
      differing[field] = value;
    }
  }
  return differing;
}

function sameValue(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}
