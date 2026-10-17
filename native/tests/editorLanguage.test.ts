import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import { Context as RootContext } from "@neoworks/extension-system";
import {
  EditorService,
  type DocumentEvent,
  type DocumentHost,
  type DocumentSummary,
  type EditorViewMethods,
} from "../plugins/editor/service";
import { LANGUAGE_COMMANDS, LANGUAGE_KEYS } from "../plugins/editor/languageCommands";
import { parseSequence } from "../kernel/keymap/keySequence";
import { LayoutService } from "../plugins/layout/service";

/** A host with one document per path, which is all opening needs. */
class PathHost implements DocumentHost {
  documents = new Map<string, DocumentSummary>();

  async open(path: string): Promise<DocumentSummary> {
    const existing = this.documents.get(path);
    if (existing) {
      return existing;
    }
    const summary = { id: this.documents.size + 1, path, title: path.split("/").pop() as string, dirty: false };
    this.documents.set(path, summary);
    return summary;
  }

  async close(): Promise<void> {}
  async save(): Promise<void> {}
  async setDecorations(): Promise<void> {}

  onEvent(_handler: (event: DocumentEvent) => void): () => void {
    return () => {};
  }
}

/** A view that records the calls the language commands make on it. */
function recordingView(calls: string[]): EditorViewMethods {
  return {
    apply: async () => ({ changed: false }),
    refresh: async () => {},
    hover: async () => void calls.push("hover"),
    definition: async () => void calls.push("definition"),
    complete: async () => void calls.push("complete"),
    references: async () => void calls.push("references"),
    typeDefinition: async () => void calls.push("typeDefinition"),
    implementation: async () => void calls.push("implementation"),
    rename: async () => void calls.push("rename"),
    codeActions: async () => void calls.push("codeActions"),
    signature: async () => void calls.push("signature"),
    format: async () => void calls.push("format"),
    goto: async (line, character) => void calls.push(`goto ${line}:${character}`),
  };
}

async function setUp(): Promise<{ editor: EditorService; layout: LayoutService }> {
  const root = new RootContext();
  let editor!: EditorService;
  let layout!: LayoutService;
  await root.plugin({
    name: "editor-test",
    apply: (ctx: Context) => {
      layout = new LayoutService(ctx, "editor", null);
      editor = new EditorService(ctx, new PathHost(), layout);
    },
  });
  return { editor, layout };
}

describe("asking the language server through the focused editor", () => {
  test("each action reaches the view of the focused pane and no other", async () => {
    const { editor, layout } = await setUp();
    const focused: string[] = [];
    const others: string[] = [];
    editor.registerView(layout.focusedLeafId, recordingView(focused));
    editor.registerView("somewhere-else", recordingView(others));
    await editor.actOnFocusedView("hover");
    await editor.actOnFocusedView("definition");
    await editor.actOnFocusedView("complete");
    expect(focused).toEqual(["hover", "definition", "complete"]);
    expect(others).toEqual([]);
  });

  test("references, rename, code actions, signature help and formatting reach the focused view too", async () => {
    const { editor, layout } = await setUp();
    const focused: string[] = [];
    editor.registerView(layout.focusedLeafId, recordingView(focused));
    for (const action of ["references", "typeDefinition", "implementation", "rename", "codeActions", "signature", "format"] as const) {
      await editor.actOnFocusedView(action);
    }
    expect(focused).toEqual(["references", "typeDefinition", "implementation", "rename", "codeActions", "signature", "format"]);
  });

  test("a notice from the host is said in the status bar", async () => {
    const root = new RootContext();
    const host = new PathHost();
    let listener: (event: DocumentEvent) => void = () => {};
    host.onEvent = (handler) => {
      listener = handler;
      return () => {};
    };
    let editor!: EditorService;
    await root.plugin({
      name: "notice-test",
      apply: (ctx: Context) => {
        editor = new EditorService(ctx, host, new LayoutService(ctx, "editor", null));
      },
    });
    listener({ type: "notice", message: "Renamed: 3 changes in 2 files" });
    expect(editor.message()).toBe("Renamed: 3 changes in 2 files");
  });

  test("with no editor in the focused pane nothing happens and nothing throws", async () => {
    const { editor } = await setUp();
    await editor.actOnFocusedView("hover");
  });
});

describe("going to a place in another file", () => {
  test("opens the file and waits for the pane to show it before moving the cursor", async () => {
    const { editor } = await setUp();
    await editor.reveal("/src/util.ts", 3, 9);
    const request = editor.pendingReveal();
    expect(request).toEqual({ documentId: 1, line: 3, character: 9 });
    expect(editor.active()?.path).toBe("/src/util.ts");
    editor.finishReveal(request!);
    expect(editor.pendingReveal()).toBeNull();
  });

  test("a file that cannot be opened leaves no request behind", async () => {
    const { editor } = await setUp();
    const failing = new PathHost();
    failing.open = () => Promise.reject(new Error("no such file"));
    const root = new RootContext();
    let other!: EditorService;
    await root.plugin({
      name: "failing",
      apply: (ctx: Context) => {
        other = new EditorService(ctx, failing, new LayoutService(ctx, "editor", null));
      },
    });
    await other.reveal("/src/missing.ts", 0, 0);
    expect(other.pendingReveal()).toBeNull();
    expect(editor.pendingReveal()).toBeNull();
  });

  test("finishing a request that was replaced does not clear the newer one", async () => {
    const { editor } = await setUp();
    await editor.reveal("/src/a.ts", 1, 1);
    const first = editor.pendingReveal()!;
    await editor.reveal("/src/b.ts", 2, 2);
    editor.finishReveal(first);
    expect(editor.pendingReveal()).toEqual({ documentId: 2, line: 2, character: 2 });
  });
});

describe("the language commands and their keys", () => {
  test("the commands the editor's context menu lists have these ids", () => {
    const ids = LANGUAGE_COMMANDS.map((command) => command.id);
    for (const id of ["editor.findReferences", "editor.rename", "editor.codeAction", "editor.formatDocument"]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every key is a sequence the keymap reads, for a command that exists, and none is bound twice", () => {
    const ids = new Set(LANGUAGE_COMMANDS.map((command) => command.id));
    for (const key of LANGUAGE_KEYS) {
      expect(ids.has(key.command)).toBe(true);
      expect(parseSequence(key.keys)).not.toBeNull();
    }
    const sequences = LANGUAGE_KEYS.map((key) => key.keys);
    expect(new Set(sequences).size).toBe(sequences.length);
    const byCommand = Object.fromEntries(LANGUAGE_KEYS.map((key) => [key.command, key.keys]));
    expect(byCommand["editor.findReferences"]).toBe("shift+f12");
    expect(byCommand["editor.rename"]).toBe("f2");
    expect(byCommand["editor.codeAction"]).toBe("ctrl+.");
  });
});
