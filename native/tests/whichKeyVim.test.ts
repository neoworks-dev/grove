import { describe, expect, test } from "bun:test";
import { vimNextKeys } from "../plugins/which-key/vimKeys";

/** The keys listed after a pending vim command, without their descriptions. */
function keysAfter(pending: string, mode = "NORMAL"): string[] {
  return vimNextKeys(pending, mode).map((next) => next.key);
}

describe("which-key's vim table", () => {
  test("lists nothing while no vim command is pending, or in insert mode", () => {
    expect(keysAfter("")).toEqual([]);
    expect(keysAfter("g", "INSERT")).toEqual([]);
  });

  test("g, z and the brackets list what finishes them", () => {
    expect(keysAfter("g")).toContain("g");
    expect(keysAfter("g")).toContain("U");
    expect(keysAfter("z")).toEqual(["t", "z", "b"]);
    expect(keysAfter("]")).toEqual(["c"]);
  });

  test("an operator lists its whole-line key, then inside, around and the motions", () => {
    const afterDelete = vimNextKeys("d", "NORMAL");
    expect(afterDelete[0]).toEqual({ key: "d", description: "Delete line", continues: false });
    expect(afterDelete[1]).toEqual({ key: "i", continues: true, group: "Inside" });
    expect(keysAfter("gU")[0]).toBe("U");
  });

  test("counts and a register in front are looked past", () => {
    expect(keysAfter("3d")).toEqual(keysAfter("d"));
    expect(keysAfter('"a2y')).toEqual(keysAfter("y"));
    expect(keysAfter("d2")).toEqual(keysAfter("d"));
  });

  test("inside and around list the text objects, in normal and visual mode", () => {
    expect(keysAfter("di")).toContain("w");
    expect(keysAfter("ca")).toContain("p");
    expect(keysAfter("i", "VISUAL")).toContain("w");
  });

  test("a register, a macro, and a keystroke with no table list what fits", () => {
    expect(keysAfter('"')).toContain("+");
    expect(keysAfter("@")).toContain("@");
    expect(keysAfter("x")).toEqual([]);
  });
});
