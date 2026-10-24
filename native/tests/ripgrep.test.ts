import { describe, expect, test } from "bun:test";
import { Context } from "@neoworks/extension-system";
import {
  MAX_FILES,
  MAX_MATCHES,
  cleanPath,
  columnOfByte,
  contentArguments,
  fileListArguments,
  parseMatch,
  parseMatches,
} from "../plugins/ripgrep/parse";
import { RipgrepService, type RipgrepAnswer, type RipgrepRunner } from "../plugins/ripgrep/service";

/** The `match` event `rg --json` prints for one line. */
function matchEvent(path: string, lineNumber: number, text: string, submatches: { start: number; end: number }[]): string {
  return JSON.stringify({
    type: "match",
    data: { path: { text: path }, lines: { text }, line_number: lineNumber, absolute_offset: 0, submatches },
  });
}

describe("reading rg --json", () => {
  test("a match gives its file, zero based line and the columns of the first hit", () => {
    const line = matchEvent("./src/a.ts", 12, "  const needle = 1;\n", [{ start: 8, end: 14 }]);
    expect(parseMatch(line)).toEqual({ path: "src/a.ts", line: 11, column: 8, endColumn: 14, text: "  const needle = 1;" });
  });

  test("columns count UTF-16 units although ripgrep counts bytes", () => {
    // "é" is two bytes and one unit; the emoji is four bytes and two units.
    const text = "é😀needle";
    const start = 2 + 4;
    expect(columnOfByte(text, start)).toBe(3);
    const match = parseMatch(matchEvent("a.ts", 1, `${text}\n`, [{ start, end: start + 6 }]));
    expect(match?.column).toBe(3);
    expect(match?.endColumn).toBe(9);
  });

  test("events that are not matches, broken lines and paths that are not text are skipped", () => {
    const begin = JSON.stringify({ type: "begin", data: { path: { text: "a.ts" } } });
    const summary = JSON.stringify({ type: "summary", data: {} });
    const binaryPath = JSON.stringify({
      type: "match",
      data: { path: { bytes: "AAEC" }, lines: { text: "x" }, line_number: 1, submatches: [] },
    });
    const good = matchEvent("b.ts", 3, "needle\n", [{ start: 0, end: 6 }]);
    expect(parseMatches([begin, "not json", binaryPath, good, summary])).toHaveLength(1);
  });

  test("a line break is dropped from the text, a windows one too", () => {
    expect(parseMatch(matchEvent("a", 1, "x\r\n", [{ start: 0, end: 1 }]))?.text).toBe("x");
  });

  test("the ./ ripgrep puts before a searched path goes", () => {
    expect(cleanPath("./a/b.ts")).toBe("a/b.ts");
    expect(cleanPath("a/b.ts")).toBe("a/b.ts");
  });
});

describe("what ripgrep is asked", () => {
  test("the file list is hidden files included, .git excluded and ordered by path", () => {
    const args = fileListArguments();
    expect(args).toContain("--files");
    expect(args).toContain("--hidden");
    expect(args.join(" ")).toContain("--glob !.git");
    expect(args.join(" ")).toContain("--sort path");
  });

  test("the query is searched as plain text and cannot be taken for a flag", () => {
    const args = contentArguments("--files (");
    expect(args).toContain("--json");
    expect(args).toContain("--fixed-strings");
    expect(args).toContain("--smart-case");
    expect(args[args.indexOf("-e") + 1]).toBe("--files (");
    expect(args[args.length - 1]).toBe(".");
  });
});

/** A service over a runner that records what it was asked and gives these answers. */
async function serviceWith(
  answer: Partial<RipgrepAnswer>,
  workspace: Record<string, unknown> = {},
): Promise<{ service: RipgrepService; requests: Parameters<RipgrepRunner>[0][] }> {
  const requests: Parameters<RipgrepRunner>[0][] = [];
  const runner: RipgrepRunner = async (request) => {
    requests.push(request);
    return { lines: [], truncated: false, cancelled: false, error: null, ...answer };
  };
  const root = new Context();
  root.provide("workspace", {
    selectedWorktree: () => null,
    repo: () => null,
    ...workspace,
  } as never);
  let service!: RipgrepService;
  await root.plugin({
    name: "ripgrep-test",
    inject: ["workspace"],
    apply(ctx: Context) {
      service = new RipgrepService(ctx, runner);
    },
  });
  return { service, requests };
}

describe("the ripgrep service", () => {
  test("it lists files under a key of their own with the file limit", async () => {
    const { service, requests } = await serviceWith({ lines: ["a.ts", "b/c.ts"] });
    const listing = await service.listFiles("/project");
    expect(listing.files).toEqual(["a.ts", "b/c.ts"]);
    expect(requests[0]).toMatchObject({ key: "files", cwd: "/project", limit: MAX_FILES, count: "lines" });
  });

  test("it searches content under another key, counting matches against the limit", async () => {
    const line = matchEvent("./a.ts", 2, "needle\n", [{ start: 0, end: 6 }]);
    const { service, requests } = await serviceWith({ lines: [JSON.stringify({ type: "begin" }), line], truncated: true });
    const search = await service.searchContent("/project", "needle");
    expect(search.matches).toHaveLength(1);
    expect(search.truncated).toBe(true);
    expect(requests[0]).toMatchObject({ key: "content", limit: MAX_MATCHES, count: "matches" });
  });

  test("a missing ripgrep comes back as a failure to show, not as an exception", async () => {
    const error = { kind: "missing" as const, message: "ripgrep (rg) is not installed or not on the PATH" };
    const { service } = await serviceWith({ error });
    expect((await service.listFiles("/p")).failure).toEqual(error);
    expect((await service.searchContent("/p", "x")).failure).toEqual(error);
  });

  test("a host that cannot be reached is a failure too", async () => {
    const root = new Context();
    root.provide("workspace", { selectedWorktree: () => null, repo: () => null } as never);
    let service!: RipgrepService;
    await root.plugin({
      name: "ripgrep-test",
      inject: ["workspace"],
      apply(ctx: Context) {
        service = new RipgrepService(ctx, async () => {
          throw new Error("no host");
        });
      },
    });
    const listing = await service.listFiles("/p");
    expect(listing.failure?.kind).toBe("failed");
    expect(listing.failure?.message).toContain("no host");
  });

  test("it searches the shown worktree, else the repository, else nothing", async () => {
    const worktree = await serviceWith({}, { selectedWorktree: () => ({ path: "/work/tree" }) });
    expect(worktree.service.root()).toBe("/work/tree");
    const repository = await serviceWith({}, { repo: () => ({ path: "/work/repo" }) });
    expect(repository.service.root()).toBe("/work/repo");
    const none = await serviceWith({});
    expect(none.service.root()).toBeNull();
  });
});
