// Small readers for untrusted JSON, shared by the manifest and recipe parsers. Each one adds a
// sentence to `problems` when the value is wrong and returns what it could salvage, so one bad
// field never costs an extension the parts that are fine.

/** Whether a value is a JSON object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A required non-empty string field; undefined, with a problem, when it is missing or not text. */
export function readString(
  object: Record<string, unknown>,
  key: string,
  where: string,
  problems: string[],
): string | undefined {
  const value = object[key];
  if (typeof value === "string" && value !== "") {
    return value;
  }
  problems.push(`${where}: "${key}" must be text`);
  return undefined;
}

/** An optional string field; undefined when absent, and, with a problem, when it is not text. */
export function readOptionalString(
  object: Record<string, unknown>,
  key: string,
  where: string,
  problems: string[],
): string | undefined {
  if (object[key] === undefined) {
    return undefined;
  }
  return readString(object, key, where, problems);
}

/** A list of non-empty strings; empty, with a problem, when the field is not one. A missing field is an empty list without a problem when `optional`. */
export function readStringList(
  object: Record<string, unknown>,
  key: string,
  where: string,
  problems: string[],
  optional = false,
): string[] {
  const value = object[key];
  if (value === undefined && optional) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    problems.push(`${where}: "${key}" must be a list of text`);
    return [];
  }
  return value as string[];
}

/** Whether a path stays inside the package it is relative to: not absolute, and never going up. */
export function isInsidePackage(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  return !path.split("/").includes("..");
}

/** A required path inside the package; undefined, with a problem, when it is not one. */
export function readPackagePath(
  object: Record<string, unknown>,
  key: string,
  where: string,
  problems: string[],
): string | undefined {
  const path = readString(object, key, where, problems);
  if (path === undefined) {
    return undefined;
  }
  if (!isInsidePackage(path)) {
    problems.push(`${where}: "${key}" must be a path inside the package`);
    return undefined;
  }
  return path;
}

/** An optional path inside the package. */
export function readOptionalPackagePath(
  object: Record<string, unknown>,
  key: string,
  where: string,
  problems: string[],
): string | undefined {
  if (object[key] === undefined) {
    return undefined;
  }
  return readPackagePath(object, key, where, problems);
}

/** Applies a reader to each element of a list field, collecting the ones that came out right. Not a list is a problem. */
export function readEach<Value>(
  object: Record<string, unknown>,
  key: string,
  where: string,
  problems: string[],
  read: (entry: unknown, entryWhere: string) => Value | null,
): Value[] {
  const value = object[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    problems.push(`${where}: "${key}" must be a list`);
    return [];
  }
  const results: Value[] = [];
  value.forEach((entry, index) => {
    const result = read(entry, `${where} ${key}[${index}]`);
    if (result !== null) {
      results.push(result);
    }
  });
  return results;
}
