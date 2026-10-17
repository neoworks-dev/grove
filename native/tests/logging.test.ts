import { describe, expect, test } from "bun:test";
import { Context } from "@neoworks/extension-system";
import { mountHostLogExporter } from "../kernel/logging";

describe("mountHostLogExporter", () => {
  test("an error is printed with its message even where the stack has only frames", () => {
    const printed: string[] = [];
    const original = console.error;
    console.error = (line: string) => void printed.push(line);
    try {
      const context = new Context();
      mountHostLogExporter(context);
      const error = new Error("plugin broke");
      // QuickJS gives an error a stack of frames alone, with no "Error: message" line.
      error.stack = "    at apply (bundle:1:1)";
      context.logger("demo").error(error);
    } finally {
      console.error = original;
    }
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("demo: Error: plugin broke");
    expect(printed[0]).toContain("at apply (bundle:1:1)");
  });
});
