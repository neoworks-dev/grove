import { describe, expect, test } from "bun:test";
import { Context } from "@neoworks/extension-system";
import { CommandsService } from "../kernel/commands";
import { KeymapService, type KeyEventInput } from "../kernel/keymap";
import { contentSearch } from "../plugins/content-search";
import { filePicker } from "../plugins/file-picker";
import type { PickerItem, PickerSource } from "../plugins/picker/service";
import type { ContentSearch, FileListing } from "../plugins/ripgrep/service";

/** A window key event as svelte-gpui delivers it. */
function press(key: string): KeyEventInput {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    preventDefault() {},
    stopPropagation() {},
  };
}

/** Lets a command that `run` started finish. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Setup {
  root: Context;
  opened: PickerSource[];
  openedPaths: string[];
  revealed: { path: string; line: number; character: number }[];
  searches: string[];
}

const NO_FAILURE = { truncated: false, cancelled: false, failure: null };

/** The keymap and commands for real, the pickers' plugins mounted over fakes of what they use. */
async function setUp(options: { root?: string | null; files?: Partial<FileListing>; search?: Partial<ContentSearch> } = {}): Promise<Setup> {
  const setup: Setup = { root: new Context(), opened: [], openedPaths: [], revealed: [], searches: [] };
  let projectRoot: string | null = "/project";
  if (options.root !== undefined) {
    projectRoot = options.root;
  }
  await setup.root.plugin(CommandsService);
  await setup.root.plugin(KeymapService);
  setup.root.provide("picker", { open: (source: PickerSource) => void setup.opened.push(source) } as never);
  setup.root.provide("ripgrep", {
    root: () => projectRoot,
    listFiles: async () => ({ files: ["a.ts", "src/b.ts"], ...NO_FAILURE, ...options.files }),
    searchContent: async (_root: string, query: string) => {
      setup.searches.push(query);
      return { matches: [{ path: "src/c.ts", line: 9, column: 4, endColumn: 10, text: "  needle" }], ...NO_FAILURE, ...options.search };
    },
  } as never);
  setup.root.provide("editor", {
    open: (path: string) => void setup.openedPaths.push(path),
    reveal: async (path: string, line: number, character: number) => void setup.revealed.push({ path, line, character }),
  } as never);
  await setup.root.plugin(filePicker);
  await setup.root.plugin(contentSearch);
  return setup;
}

describe("the leader bindings", () => {
  test("space space opens the file picker and space slash the content search", async () => {
    const setup = await setUp();
    setup.root.keymap.allowBareKeys(() => true);
    expect(setup.root.keymap.dispatch(press(" "))).toBe(true);
    expect(setup.root.keymap.dispatch(press(" "))).toBe(true);
    await settle();
    expect(setup.opened.map((source) => source.placeholder)).toEqual(["Go to file"]);
    setup.root.keymap.dispatch(press(" "));
    setup.root.keymap.dispatch(press("/"));
    await settle();
    expect(setup.opened.map((source) => source.placeholder)).toEqual(["Go to file", "Search in files"]);
  });

  test("the keymap leaves a bare space to the editor until something vouches that nothing is typing", async () => {
    const setup = await setUp();
    expect(setup.root.keymap.dispatch(press(" "))).toBe(false);
    await settle();
    expect(setup.opened).toHaveLength(0);
  });

  test("the keymap knows a leader key is bound, which is what makes vim leave space to it", async () => {
    const setup = await setUp();
    expect(setup.root.keymap.hasLeaderBindings()).toBe(true);
    expect(setup.root.keymap.isPending()).toBe(false);
    setup.root.keymap.allowBareKeys(() => true);
    setup.root.keymap.dispatch(press(" "));
    expect(setup.root.keymap.isPending()).toBe(true);
  });

  test("while space is pending which-key lists both pickers", async () => {
    const setup = await setUp();
    setup.root.keymap.allowBareKeys(() => true);
    setup.root.keymap.dispatch(press(" "));
    const next = setup.root.keymap.nextKeys();
    expect(next).toContainEqual({ key: "␣", description: "Find file", continues: false });
    expect(next).toContainEqual({ key: "/", description: "Search in files", continues: false });
  });

  test("the pickers are also commands, for the palette", async () => {
    const setup = await setUp();
    expect(setup.root.commands.canRun("picker.files")).toBe(true);
    expect(setup.root.commands.canRun("picker.content")).toBe(true);
  });
});

/** The source the keys opened, `which` of them. */
async function sourceOpenedBy(setup: Setup, keys: string[]): Promise<PickerSource> {
  setup.root.keymap.allowBareKeys(() => true);
  for (const key of keys) {
    setup.root.keymap.dispatch(press(key));
  }
  await settle();
  return setup.opened[setup.opened.length - 1];
}

describe("the file picker source", () => {
  test("it loads the project's files as rows and opens the chosen one in the editor", async () => {
    const setup = await setUp();
    const source = await sourceOpenedBy(setup, [" ", " "]);
    expect(source.mode).toBe("filter");
    const loaded = await source.load("");
    expect(loaded.items.map((item) => item.title)).toEqual(["a.ts", "b.ts"]);
    source.choose(loaded.items[1]);
    expect(setup.openedPaths).toEqual(["/project/src/b.ts"]);
  });

  test("without ripgrep it says so", async () => {
    const failure = { kind: "missing" as const, message: "ripgrep (rg) is not installed or not on the PATH" };
    const setup = await setUp({ files: { files: [], failure } });
    const source = await sourceOpenedBy(setup, [" ", " "]);
    expect(await source.load("")).toEqual({ items: [], message: failure.message });
  });

  test("with no folder open it says what to do", async () => {
    const setup = await setUp({ root: null });
    const source = await sourceOpenedBy(setup, [" ", " "]);
    expect((await source.load("")).message).toBe("Open a folder to find its files");
  });

  test("a cut list says how many files it shows", async () => {
    const setup = await setUp({ files: { truncated: true } });
    const source = await sourceOpenedBy(setup, [" ", " "]);
    expect((await source.load("")).message).toBe("Showing the first 2 files");
  });
});

describe("the content search source", () => {
  test("it searches as asked and opens the chosen match at its line and column", async () => {
    const setup = await setUp();
    const source = await sourceOpenedBy(setup, [" ", "/"]);
    expect(source.mode).toBe("live");
    const loaded = await source.load("needle");
    expect(setup.searches).toEqual(["needle"]);
    const item: PickerItem = loaded.items[0];
    expect(item.target).toEqual({ path: "/project/src/c.ts", line: 9, column: 4, endColumn: 10 });
    source.choose(item);
    await settle();
    expect(setup.revealed).toEqual([{ path: "/project/src/c.ts", line: 9, character: 4 }]);
  });

  test("a query too short to be worth a search does not run ripgrep", async () => {
    const setup = await setUp();
    const source = await sourceOpenedBy(setup, [" ", "/"]);
    const loaded = await source.load("n");
    expect(loaded.items).toEqual([]);
    expect(setup.searches).toEqual([]);
  });

  test("a failed search shows ripgrep's message", async () => {
    const failure = { kind: "failed" as const, message: "regex parse error" };
    const setup = await setUp({ search: { matches: [], failure } });
    const source = await sourceOpenedBy(setup, [" ", "/"]);
    expect(await source.load("needle")).toEqual({ items: [], message: "regex parse error" });
  });
});
