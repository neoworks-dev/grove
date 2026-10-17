import { describe, expect, test } from "bun:test";
import { Context as RootContext, type Context } from "@neoworks/extension-system";
import { leaves } from "../plugins/layout/layoutTree";
import { LayoutService } from "../plugins/layout/service";

/** A layout of one editor pane. */
async function setUp(): Promise<LayoutService> {
  const root = new RootContext();
  let layout!: LayoutService;
  await root.plugin({
    name: "layout-test",
    apply: (ctx: Context) => {
      layout = new LayoutService(ctx, "editor", null);
    },
  });
  return layout;
}

describe("a pane's state", () => {
  test("starts empty and keeps what a plugin records", async () => {
    const layout = await setUp();
    const [pane] = leaves(layout.root);
    expect(layout.paneState(pane.id)).toEqual({});
    layout.setPaneState(pane.id, { sessionId: "a" });
    layout.setPaneState(pane.id, { scroll: 3 });
    expect(layout.paneState(pane.id)).toEqual({ sessionId: "a", scroll: 3 });
  });

  test("is empty for a pane that does not exist, and recording for one changes nothing", async () => {
    const layout = await setUp();
    const before = layout.root;
    expect(layout.paneState("missing")).toEqual({});
    layout.setPaneState("missing", { sessionId: "a" });
    expect(layout.root).toBe(before);
  });
});

describe("splitting with a pane type", () => {
  test("opens a pane of that type instead of the type that was split", async () => {
    const layout = await setUp();
    layout.splitFocused("row", "agent");
    expect(leaves(layout.root).map((pane) => pane.paneTypeId)).toEqual(["editor", "agent"]);
    expect(layout.paneTypeOf(layout.focusedLeafId)).toBe("agent");
  });

  test("without one still splits into the same type", async () => {
    const layout = await setUp();
    layout.splitFocused("row");
    expect(leaves(layout.root).map((pane) => pane.paneTypeId)).toEqual(["editor", "editor"]);
  });
});
