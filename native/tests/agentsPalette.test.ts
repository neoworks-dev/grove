import { describe, expect, test } from "bun:test";
import { blend, palette, paletteFrom } from "../plugins/agents/palette";
import { NEOWORKS_DARK } from "../plugins/theme/palette";
import { setActiveTokens } from "../plugins/theme/active";

describe("the chat palette", () => {
  test("is Grove's tokens under the names the chat uses", () => {
    const chat = paletteFrom(NEOWORKS_DARK);
    expect(chat.fg).toBe(NEOWORKS_DARK.text);
    expect(chat.bg).toBe(NEOWORKS_DARK.surface);
    expect(chat.success).toBe(NEOWORKS_DARK.green);
    expect(chat.danger).toBe(NEOWORKS_DARK.red);
    expect(chat.band).not.toBe(chat.bg);
  });

  test("follows the active theme", () => {
    const before = palette.fg;
    setActiveTokens({ ...NEOWORKS_DARK, text: "#112233" }, "dark");
    expect(palette.fg).toBe("#112233");
    setActiveTokens(NEOWORKS_DARK, "dark");
    expect(palette.fg).toBe(before);
  });

  test("blends a share of one colour into another", () => {
    expect(blend("#000000", "#ffffff", 50)).toBe("#808080");
    expect(blend("#102030", "#ffffff", 0)).toBe("#102030");
    expect(blend("transparent", "#ffffff", 50)).toBe("transparent");
  });
});
