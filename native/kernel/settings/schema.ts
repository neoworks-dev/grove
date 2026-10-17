// How a plugin describes its config. A schema is a Standard Schema, so it is what the plugin
// object's `Config` holds and the extension system validates a row's config against it, and it
// also carries `fields`, a description the settings page draws a form from. Validating fills
// in defaults, so a plugin's `apply` always receives every field.

import type { StandardSchemaV1 } from "@neoworks/extension-system";
import { parseSequence } from "../keymap/keySequence";

export interface EnumOption {
  value: string;
  label: string;
}

interface FieldBase<Value> {
  /** What the form calls the field. */
  label: string;
  /** One sentence under the label. */
  description?: string;
  /** What the plugin uses when the profile does not set the field. */
  default: Value;
  /**
   * Whether the plugin follows a change without being unloaded and loaded again. A live field
   * is delivered to the plugin's `settings.onLive` handler; any other field restarts the plugin.
   */
  live?: boolean;
}

export interface StringField extends FieldBase<string> {
  type: "string";
}

export interface NumberField extends FieldBase<number> {
  type: "number";
  min?: number;
  max?: number;
}

export interface BooleanField extends FieldBase<boolean> {
  type: "boolean";
}

export interface EnumField extends FieldBase<string> {
  type: "enum";
  /** The choices, or the name of a list a plugin supplies with `settings.registerOptions`. */
  options: EnumOption[] | string;
}

/** A `#rrggbb` or `#rrggbbaa` colour; the empty string means none. */
export interface ColorField extends FieldBase<string> {
  type: "color";
}

/** A key sequence in the keymap's grammar, such as `ctrl+shift+p`; the empty string means none. */
export interface KeybindingField extends FieldBase<string> {
  type: "keybinding";
}

export type SettingField = StringField | NumberField | BooleanField | EnumField | ColorField | KeybindingField;

export type SettingValue = string | number | boolean;

export type SettingFields = Record<string, SettingField>;

/** The config object a schema produces: each field's value. */
export type SettingValues<Fields extends SettingFields> = {
  [Name in keyof Fields]: Fields[Name]["default"];
};

export interface SettingsSchema<Values = Record<string, SettingValue>> extends StandardSchemaV1<unknown, Values> {
  readonly fields: SettingFields;
}

type FieldOptions<Field extends SettingField> = Omit<Field, "type">;

/** Builders for the fields of a schema. */
export const setting = {
  string: (options: FieldOptions<StringField>): StringField => ({ type: "string", ...options }),
  number: (options: FieldOptions<NumberField>): NumberField => ({ type: "number", ...options }),
  boolean: (options: FieldOptions<BooleanField>): BooleanField => ({ type: "boolean", ...options }),
  enum: (options: FieldOptions<EnumField>): EnumField => ({ type: "enum", ...options }),
  color: (options: FieldOptions<ColorField>): ColorField => ({ type: "color", ...options }),
  keybinding: (options: FieldOptions<KeybindingField>): KeybindingField => ({ type: "keybinding", ...options }),
};

/** Describes a plugin's config: the plugin object's `Config`, and the form the settings page shows. */
export function defineSettings<Fields extends SettingFields>(fields: Fields): SettingsSchema<SettingValues<Fields>> {
  return {
    fields,
    "~standard": {
      version: 1,
      vendor: "grove",
      validate: (input) => validateAgainst(fields, input) as StandardSchemaV1.Result<SettingValues<Fields>>,
    },
  };
}

/** The schema a plugin declares as its `Config`, or undefined for a plugin with no settings. */
export function schemaOfPlugin(plugin: unknown): SettingsSchema | undefined {
  if (typeof plugin !== "object" && typeof plugin !== "function") {
    return undefined;
  }
  if (plugin === null) {
    return undefined;
  }
  const config = (plugin as { Config?: unknown }).Config;
  if (typeof config !== "object" || config === null) {
    return undefined;
  }
  if (!("fields" in config)) {
    return undefined;
  }
  return config as SettingsSchema;
}

/** What a field holds when the profile does not set it. */
export function defaultsOf(fields: SettingFields): Record<string, SettingValue> {
  const defaults: Record<string, SettingValue> = {};
  for (const [name, field] of Object.entries(fields)) {
    defaults[name] = field.default;
  }
  return defaults;
}

/** Why a value is not acceptable for a field, or null when it is. */
export function describeFieldProblem(field: SettingField, value: unknown): string | null {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "number":
      return describeNumberProblem(field, value);
    case "enum":
      return describeEnumProblem(field, value);
    case "color":
      return describeColorProblem(value);
    case "keybinding":
      return describeKeybindingProblem(value);
    case "string":
      return typeof value === "string" ? null : "must be text";
  }
}

function describeNumberProblem(field: NumberField, value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "must be a number";
  }
  if (field.min !== undefined && value < field.min) {
    return `must be at least ${field.min}`;
  }
  if (field.max !== undefined && value > field.max) {
    return `must be at most ${field.max}`;
  }
  return null;
}

function describeEnumProblem(field: EnumField, value: unknown): string | null {
  if (typeof value !== "string") {
    return "must be one of the listed choices";
  }
  // A named list is only known to the settings service, so the schema accepts any text for it.
  if (typeof field.options === "string") {
    return null;
  }
  if (field.options.some((option) => option.value === value)) {
    return null;
  }
  return `must be one of ${field.options.map((option) => option.value).join(", ")}`;
}

function describeColorProblem(value: unknown): string | null {
  if (typeof value !== "string") {
    return "must be a colour such as #a78bfa";
  }
  if (value === "" || /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) {
    return null;
  }
  return "must be a colour such as #a78bfa";
}

function describeKeybindingProblem(value: unknown): string | null {
  if (typeof value !== "string") {
    return "must be a key sequence such as ctrl+shift+p";
  }
  if (value === "" || parseSequence(value) !== null) {
    return null;
  }
  return "is not a key sequence the keymap understands";
}

/** The Standard Schema validation: defaults filled in, every given field checked, other keys passed through. */
function validateAgainst(fields: SettingFields, input: unknown): StandardSchemaV1.Result<Record<string, unknown>> {
  if (input === undefined || input === null) {
    return { value: defaultsOf(fields) };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { issues: [{ message: "config must be an object" }] };
  }
  const given = input as Record<string, unknown>;
  const value: Record<string, unknown> = { ...given };
  const issues: StandardSchemaV1.Issue[] = [];
  for (const [name, field] of Object.entries(fields)) {
    if (given[name] === undefined) {
      value[name] = field.default;
      continue;
    }
    const problem = describeFieldProblem(field, given[name]);
    if (problem !== null) {
      issues.push({ message: `${name} ${problem}`, path: [name] });
    }
  }
  if (issues.length > 0) {
    return { issues };
  }
  return { value };
}
