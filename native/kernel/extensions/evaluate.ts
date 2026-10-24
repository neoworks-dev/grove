// Runs the script of an extension's plugin. An extension is built into one script (see
// `scripts/buildExtension.mjs`) that leaves the framework's modules, Svelte and Grove's own,
// external and asks for them with `require`. The app has exactly one copy of each of those, and
// the script has to use it: a second copy of Svelte's runtime would not share its state.

import type { Plugin } from "@neoworks/extension-system";

/** The modules a script may `require`, by name. `@grove/extension` is the one that gets `definePlugin` added. */
export type SharedModules = Record<string, unknown>;

/** The module name an extension script imports Grove's API from. */
export const API_MODULE = "@grove/extension";

/** Runs a script of text, with `require`, `module` and `exports` in scope, and returns what it exports. */
type ScriptRunner = (require: (id: string) => unknown, module: { exports: unknown }, exports: unknown) => void;

/**
 * Runs the script and returns the plugin it contributed: what it passed to `definePlugin`, or
 * else what it assigned to `module.exports`. Throws with a sentence when the script fails,
 * asks for a module the app does not share, or contributes nothing usable.
 */
export function evaluateExtensionScript(code: string, label: string, modules: SharedModules): Plugin {
  let defined: unknown;
  const module = { exports: {} as unknown };
  const require = (id: string): unknown => {
    if (id === API_MODULE) {
      const definePlugin = (plugin: unknown): unknown => {
        defined = plugin;
        return plugin;
      };
      return { ...(modules[id] as object), definePlugin };
    }
    if (id in modules) {
      return modules[id];
    }
    throw new Error(`${label} needs the module "${id}", which Grove does not provide to extensions`);
  };
  runScript(code, label, require, module);
  const plugin = pickPlugin(defined, module.exports);
  if (plugin === null) {
    throw new Error(`${label} did not contribute a plugin: call definePlugin with an object that has an apply function`);
  }
  return plugin;
}

/** Compiles the script into a function and calls it; a syntax error names the script. */
function runScript(code: string, label: string, require: (id: string) => unknown, module: { exports: unknown }): void {
  let run: ScriptRunner;
  try {
    run = new Function("require", "module", "exports", `${code}\n//# sourceURL=${label}`) as ScriptRunner;
  } catch (error) {
    throw new Error(`${label} could not be read: ${describeError(error)}`);
  }
  run(require, module, module.exports);
}

/** The contributed plugin: the `definePlugin` argument if it is one, else the export if that is. */
function pickPlugin(defined: unknown, exported: unknown): Plugin | null {
  if (isPluginObject(defined)) {
    return defined as Plugin;
  }
  if (isPluginObject(exported)) {
    return exported as Plugin;
  }
  const defaultExport = (exported as { default?: unknown } | null)?.default;
  if (isPluginObject(defaultExport)) {
    return defaultExport as Plugin;
  }
  return null;
}

/** Whether a value is the object form of a plugin: it has an `apply` function. */
function isPluginObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return typeof (value as { apply?: unknown }).apply === "function";
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
