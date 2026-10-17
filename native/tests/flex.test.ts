import { describe, expect, it } from "bun:test";
import { parseFlex } from "../plugins/layout/flex";
import { splitChildFlex } from "../plugins/layout/layoutTree";

describe("parseFlex", () => {
  it("reads shares", () => {
    expect(parseFlex("0.5 1 0%")).toEqual({ grow: 0.5, shrink: 1, basis: "0%" });
  });

  it("reads a pixel basis as a number", () => {
    expect(parseFlex("0 0 240px")).toEqual({ grow: 0, shrink: 0, basis: 240 });
  });

  it("reads what splitChildFlex writes", () => {
    const parsed = splitChildFlex([0.25, 0.75], [240, null]).map(parseFlex);
    expect(parsed[0]).toEqual({ grow: 0, shrink: 0, basis: 240 });
    expect(parsed[1].grow).toBe(1);
  });
});
