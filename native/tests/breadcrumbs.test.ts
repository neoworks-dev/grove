import { describe, expect, test } from "bun:test";
import { Context as RootContext, type Context } from "@neoworks/extension-system";
import { iconNameOf, pathSteps, type Scope } from "../plugins/breadcrumbs/model";
import type { ScopeHost } from "../plugins/breadcrumbs/scopeHost";
import { BreadcrumbsService } from "../plugins/breadcrumbs/service";
import { EditorService } from "../plugins/editor/service";
import { LayoutService } from "../plugins/layout/service";
import { FakeDocuments } from "./support/fakeDiffHost";
import { settle } from "./support/fakeSidecar";

/** A scope that starts at a row, for tests that only care which one is shown. */
function scope(kind: string, name: string, row: number): Scope {
  return { kind, name, start: { row, column: 0 }, end: { row: row + 5, column: 1 }, startCharacter: 0 };
}

describe("the path steps of the bar", () => {
  test("a file inside the worktree is shown from the worktree's root, each step knowing its own path", () => {
    expect(pathSteps("/repo/src/deep/file.ts", "/repo")).toEqual([
      { name: "src", relativePath: "src", isFile: false },
      { name: "deep", relativePath: "src/deep", isFile: false },
      { name: "file.ts", relativePath: "src/deep/file.ts", isFile: true },
    ]);
  });

  test("a file outside the worktree, or with no worktree, is shown from the filesystem's root", () => {
    expect(pathSteps("/other/a.ts", "/repo").map((step) => step.name)).toEqual(["other", "a.ts"]);
    expect(pathSteps("/a.ts", null).map((step) => step.name)).toEqual(["a.ts"]);
  });

  test("text that belongs to no file has no path", () => {
    expect(pathSteps("", "/repo")).toEqual([]);
  });

  test("each kind of scope has an icon, and an unknown one gets the function's", () => {
    expect(iconNameOf("class")).toBe("cube");
    expect(iconNameOf("trait")).toBe("puzzle-piece");
    expect(iconNameOf("macro")).toBe("function");
  });
});

/** A host that answers from what the test sets, and records what it was asked. */
class FakeScopes implements ScopeHost {
  answer: Scope[] = [];
  asked: string[] = [];
  /** When set, the next answer waits for it. */
  hold: Promise<void> | null = null;

  async scopesAt(documentId: number, row: number, column: number): Promise<Scope[]> {
    this.asked.push(`${documentId}:${row}:${column}`);
    const held = this.hold;
    this.hold = null;
    const answer = this.answer;
    if (held) {
      await held;
    }
    return answer;
  }
}

/** The service over a fake editor with one file open, and a short pause before it asks. */
async function setUp() {
  const root = new RootContext();
  const documents = new FakeDocuments();
  documents.files.set("/repo/a.ts", "x");
  const scopes = new FakeScopes();
  let editor!: EditorService;
  let service!: BreadcrumbsService;
  await root.plugin({
    name: "breadcrumbs-test",
    apply: (ctx: Context) => {
      const layout = new LayoutService(ctx, "editor", null);
      editor = new EditorService(ctx, documents, layout);
      service = new BreadcrumbsService(ctx, editor, scopes, { restDelayMs: 5 });
    },
  });
  const id = await editor.openPath("/repo/a.ts");
  return { documents, scopes, editor, service, id: id as number };
}

describe("the breadcrumbs service", () => {
  test("a document that is opened gets the scopes at its cursor", async () => {
    const { scopes, service, id } = await setUp();
    scopes.answer = [scope("class", "Server", 0)];
    await settle(20);
    expect(service.scopesOf(id).map((entry) => entry.name)).toEqual(["Server"]);
  });

  test("scopes follow the cursor, asked once it has rested", async () => {
    const { documents, scopes, service, id } = await setUp();
    await settle(20);
    scopes.asked.length = 0;
    scopes.answer = [scope("class", "Server", 0), scope("method", "start", 3)];
    for (const row of [1, 2, 3, 4]) {
      documents.emit({ type: "selections", id, row, column: 2, count: 1, selected: false });
    }
    await settle(30);
    expect(scopes.asked).toEqual([`${id}:4:2`]);
    expect(service.scopesOf(id).map((entry) => entry.name)).toEqual(["Server", "start"]);
  });

  test("an edit asks again, since it can add or rename a scope", async () => {
    const { documents, scopes, service, id } = await setUp();
    await settle(20);
    scopes.answer = [scope("function", "renamed", 0)];
    documents.emit({ type: "edited", id });
    await settle(30);
    expect(service.scopesOf(id)[0].name).toBe("renamed");
  });

  test("a slow answer for an old cursor does not replace a newer one", async () => {
    const { documents, scopes, service, id } = await setUp();
    await settle(20);
    let release!: () => void;
    scopes.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    scopes.answer = [scope("function", "old", 0)];
    documents.emit({ type: "selections", id, row: 1, column: 0, count: 1, selected: false });
    await settle(20);
    scopes.answer = [scope("function", "new", 9)];
    documents.emit({ type: "selections", id, row: 9, column: 0, count: 1, selected: false });
    await settle(20);
    release();
    await settle(10);
    expect(service.scopesOf(id).map((entry) => entry.name)).toEqual(["new"]);
  });

  test("a closed document is forgotten, and a host that fails leaves what was there", async () => {
    const { documents, scopes, service, id } = await setUp();
    scopes.answer = [scope("function", "f", 0)];
    await settle(20);
    scopes.scopesAt = async () => {
      throw new Error("document is not open");
    };
    documents.emit({ type: "edited", id });
    await settle(20);
    expect(service.scopesOf(id)).toHaveLength(1);
    documents.emit({ type: "closed", id });
    expect(service.scopesOf(id)).toEqual([]);
  });
});
