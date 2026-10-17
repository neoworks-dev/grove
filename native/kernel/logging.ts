// Sends the kernel's log to the host's log, where `console.*` from the bundle ends up. Fibers
// log their own failures through `ctx.logger`, so mounting this makes every plugin error
// visible outside the UI as well as inside it.

import { Logger, LoggerLevel, type Context, type Exporter } from "@neoworks/extension-system";

/** Prints each log message, errors with their stacks, and returns the function that stops it. */
export function mountHostLogExporter(context: Context): () => void {
  const exporter: Exporter = {
    colors: false,
    levels: { default: LoggerLevel.INFO },
    export(message) {
      const line = `[${message.type}] ${message.name}: ${Logger.format(exporter, message)}`;
      if (message.type === "error") {
        console.error(line);
        return;
      }
      if (message.type === "warn") {
        console.warn(line);
        return;
      }
      console.log(line);
    },
  };
  return context.logger.exporter(exporter);
}
