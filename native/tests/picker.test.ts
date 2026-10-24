import { describe, expect, test } from "bun:test";
import { Context } from "@neoworks/extension-system";
import { CommandsService } from "../kernel/commands";
import { KeymapService } from "../kernel/keymap";
import { matchItem, matchItems } from "../plugins/content-search/items";
import type { Decoration } from "../plugins/editor/decorations";
import { fileItem, fileItems } from "../plugins/file-picker/items";
import { PaletteService } from "../plugins/palette/service";
import { MATCH_SOURCE, MAX_PREVIEW_BYTES, PreviewLoader, type PreviewHost, type PreviewState } from "../plugins/picker/preview";
import { PickerService, type PickerItem, type PickerSource } from "../plugins/picker/service";

describe("file picker rows", () => {
  test("the file name is the title and the directory the dim text after it", () => {
    const item = fileItem("/project", "native/plugins/picker/index.ts");
    expect(item.title).toBe("index.ts");
    expect(item.detail).toBe("native/plugins/picker");
    expect(item.target).toEqual({ path: "/project/native/plugins/picker/index.ts", line: 0, column: 0 });
  });

  test("a file in the root has no directory", () => {
    expect(fileItem("/project", "README.md").detail).toBe("");
  });
});

describe("content search rows", () => {
  const match = { path: "src/a/b.ts", line: 41, column: 8, endColumn: 14, text: "    const needle = 1;" };

  test("the line is the title and the file and line number follow it", () => {
    const item = matchItem("/project", match, 0);
    expect(item.title).toBe("const needle = 1;");
    expect(item.detail).toBe("b.ts:42");
    expect(item.location).toBe("src/a/b.ts:42");
  });

  test("the preview is told where the match is so it can highlight it", () => {
    expect(matchItem("/project", match, 0).target).toEqual({
      path: "/project/src/a/b.ts",
      line: 41,
      column: 8,
      endColumn: 14,
    });
  });

  test("two matches on the same line of a file stay separate rows", () => {
    const ids = matchItems("/project", [match, match]).map((item) => item.id);
    expect(new Set(ids).size).toBe(2);
  });

  test("a very long line is cut so it costs nothing to draw", () => {
    const long = matchItem("/project", { ...match, text: "x".repeat(5000) }, 0);
    expect(long.title.length).toBeLessThan(300);
  });
});

/** A root context with the palette, which the picker ranks with, and the picker over it. */
async function pickerContext(): Promise<Context> {
  const root = new Context();
  await root.plugin(CommandsService);
  await root.plugin(KeymapService);
  await root.plugin({
    name: "palette",
    inject: ["commands", "keymap"],
    apply(ctx: Context) {
      new PaletteService(ctx);
    },
  });
  await root.plugin({
    name: "picker",
    inject: ["palette"],
    apply(ctx: Context) {
      new PickerService(ctx);
    },
  });
  return root;
}

/** A source over these items that remembers what was chosen. */
function sourceOf(items: PickerItem[], chosen: PickerItem[] = []): PickerSource {
  return {
    placeholder: "Find",
    mode: "filter",
    load: async () => ({ items }),
    choose: (item) => void chosen.push(item),
  };
}

describe("the picker service", () => {
  test("it shows a source until it is closed", async () => {
    const root = await pickerContext();
    expect(root.picker.isOpen()).toBe(false);
    root.picker.open(sourceOf([]));
    expect(root.picker.isOpen()).toBe(true);
    root.picker.close();
    expect(root.picker.session()).toBeNull();
  });

  test("choosing closes it and hands the item to the source", async () => {
    const root = await pickerContext();
    const chosen: PickerItem[] = [];
    const [item] = fileItems("/p", ["a.ts"]);
    root.picker.open(sourceOf([item], chosen));
    root.picker.choose(item);
    expect(root.picker.isOpen()).toBe(false);
    expect(chosen).toEqual([item]);
  });

  test("it ranks by the palette's matcher, a file name outranking a directory", async () => {
    const root = await pickerContext();
    const items = fileItems("/p", ["picker/notes.md", "src/picker.ts", "docs/readme.md"]);
    expect(root.picker.rank(items, "picker").map((item) => item.id)).toEqual(["src/picker.ts", "picker/notes.md"]);
  });

  test("letters of the path in order find a file, and every file stays listed for an empty query", async () => {
    const root = await pickerContext();
    const items = fileItems("/p", ["plugins/picker/index.ts", "plugins/palette/index.ts", "README.md"]);
    expect(root.picker.rank(items, "plpkix").map((item) => item.id)).toEqual(["plugins/picker/index.ts"]);
    expect(root.picker.rank(items, "")).toHaveLength(3);
  });
});

/** A host over these files, which records what the preview opened, released and decorated. */
class FakePreviewHost implements PreviewHost {
  files = new Map<string, string>();
  sizes = new Map<string, number>();
  opened: { name: string; text: string; id: number }[] = [];
  released: number[] = [];
  decorated: { id: number; source: string; decorations: Decoration[] }[] = [];
  private nextId = 1;
  /** Held reads wait until their path is let go. */
  private waiting = new Map<string, () => void>();
  hold = new Set<string>();

  async sizeOf(path: string): Promise<number> {
    const size = this.sizes.get(path);
    if (size !== undefined) {
      return size;
    }
    const text = this.files.get(path);
    if (text === undefined) {
      throw new Error("not found");
    }
    return text.length;
  }

  async readText(path: string): Promise<string> {
    if (this.hold.has(path)) {
      await new Promise<void>((resolve) => this.waiting.set(path, resolve));
    }
    const text = this.files.get(path);
    if (text === undefined) {
      throw new Error("not text");
    }
    return text;
  }

  let(path: string): void {
    this.hold.delete(path);
    this.waiting.get(path)?.();
  }

  async openText(name: string, text: string): Promise<number | null> {
    const id = this.nextId;
    this.nextId += 1;
    this.opened.push({ name, text, id });
    return id;
  }

  async release(documentId: number): Promise<void> {
    this.released.push(documentId);
  }

  async decorate(id: number, source: string, decorations: Decoration[]): Promise<void> {
    this.decorated.push({ id, source, decorations });
  }
}

/** A loader over a fake host that keeps the states it published. */
function loaderOver(host: FakePreviewHost): { loader: PreviewLoader; states: PreviewState[] } {
  const states: PreviewState[] = [];
  const loader = new PreviewLoader(host, (state) => void states.push(state));
  return { loader, states };
}

describe("the preview", () => {
  test("it shows a file as a document named after it, at the target line", async () => {
    const host = new FakePreviewHost();
    host.files.set("/p/src/a.ts", "one\ntwo\n");
    const { loader, states } = loaderOver(host);
    await loader.show({ path: "/p/src/a.ts", line: 1, column: 2 });
    expect(host.opened).toEqual([{ name: "a.ts", text: "one\ntwo\n", id: 1 }]);
    expect(states.at(-1)).toEqual({ kind: "document", documentId: 1, line: 1, column: 2 });
  });

  test("a match is highlighted, and a file picker target is not", async () => {
    const host = new FakePreviewHost();
    host.files.set("/p/a.ts", "const needle = 1;\n");
    const { loader } = loaderOver(host);
    await loader.show({ path: "/p/a.ts", line: 0, column: 6, endColumn: 12 });
    await loader.show({ path: "/p/a.ts", line: 0, column: 0 });
    expect(host.decorated).toHaveLength(1);
    expect(host.decorated[0].source).toBe(MATCH_SOURCE);
    expect(host.decorated[0].decorations[0]).toMatchObject({
      kind: "highlight",
      start: { row: 0, column: 6 },
      end: { row: 0, column: 12 },
    });
  });

  test("the document it replaces is let go, so moving down the list leaks nothing", async () => {
    const host = new FakePreviewHost();
    host.files.set("/p/a.ts", "a");
    host.files.set("/p/b.ts", "b");
    const { loader } = loaderOver(host);
    await loader.show({ path: "/p/a.ts", line: 0, column: 0 });
    await loader.show({ path: "/p/b.ts", line: 0, column: 0 });
    expect(host.released).toEqual([1]);
    await loader.dispose();
    expect(host.released).toEqual([1, 2]);
  });

  test("a file over the size cap is not read", async () => {
    const host = new FakePreviewHost();
    host.files.set("/p/big.log", "x");
    host.sizes.set("/p/big.log", MAX_PREVIEW_BYTES + 1);
    const { loader, states } = loaderOver(host);
    await loader.show({ path: "/p/big.log", line: 0, column: 0 });
    expect(host.opened).toHaveLength(0);
    expect(states.at(-1)).toEqual({ kind: "notice", message: "Too large to preview" });
  });

  test("a file that cannot be read says so instead of failing", async () => {
    const host = new FakePreviewHost();
    const { loader, states } = loaderOver(host);
    await loader.show({ path: "/p/missing.bin", line: 0, column: 0 });
    expect(states.at(-1)).toEqual({ kind: "notice", message: "Cannot preview this file" });
  });

  test("a read that finishes after a newer request is dropped and its document let go", async () => {
    const host = new FakePreviewHost();
    host.files.set("/p/slow.ts", "slow");
    host.files.set("/p/fast.ts", "fast");
    host.hold.add("/p/slow.ts");
    const { loader, states } = loaderOver(host);
    const slow = loader.show({ path: "/p/slow.ts", line: 0, column: 0 });
    await loader.show({ path: "/p/fast.ts", line: 0, column: 0 });
    host.let("/p/slow.ts");
    await slow;
    const last = states.at(-1);
    expect(last).toMatchObject({ kind: "document", documentId: 1 });
    expect(host.opened.map((entry) => entry.name)).toEqual(["fast.ts", "slow.ts"]);
    expect(host.released).toEqual([2]);
  });

  test("showing nothing clears the preview", async () => {
    const host = new FakePreviewHost();
    const { loader, states } = loaderOver(host);
    await loader.show(null);
    expect(states.at(-1)).toEqual({ kind: "empty" });
  });
});
