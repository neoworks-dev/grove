// Sends the kernel's log to the host's log, where `console.*` from the bundle ends up. Fibers
// log their own failures through `ctx.logger`, so mounting this makes every plugin error
// visible outside the UI as well as inside it.

import { Logger, LoggerLevel, type Context, type Exporter, type Message } from "@neoworks/extension-system";

/**
 * The message with an error's name and message put in front of its stack. V8 starts `stack`
 * with them, as the logger expects, but QuickJS's `stack` holds only the frames, so a logged
 * error would otherwise show where it happened and not what it was.
 */
function withErrorHeader(message: Message): Message {
  const [first, ...rest] = message.args;
  if (!(first instanceof Error)) {
    return message;
  }
  const header = `${first.name}: ${first.message}`;
  if (first.stack && first.stack.startsWith(header)) {
    return message;
  }
  const described = new Error(first.message);
  described.stack = `${header}\n${first.stack}`;
  return { ...message, args: [described, ...rest] };
}

/** Prints each log message, errors with their stacks, and returns the function that stops it. */
export function mountHostLogExporter(context: Context): () => void {
  const exporter: Exporter = {
    colors: false,
    levels: { default: LoggerLevel.INFO },
    export(message) {
      // The host's console already says whether a line is an error, so the line says only who logged it.
      const line = `${message.name}: ${Logger.format(exporter, withErrorHeader(message))}`;
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
