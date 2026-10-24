import { describe, expect, test } from "bun:test";
import { DEFAULT_ICON_SET_ID, ICON_SETS, extensionOf, iconForFile, iconForFolder, iconSetOf } from "../plugins/explorer/fileIcons";

const material = iconSetOf("material");
const monochrome = iconSetOf("monochrome");

describe("icon sets", () => {
  test("the Material set is the default, and an unknown id falls back to it", () => {
    expect(DEFAULT_ICON_SET_ID).toBe("material");
    expect(iconSetOf("nonsense")).toBe(material);
    expect(ICON_SETS.map((set) => set.id)).toEqual(["material", "monochrome"]);
  });

  test("extensionOf reads the part after the last dot", () => {
    expect(extensionOf("main.rs")).toBe("rs");
    expect(extensionOf("App.TEST.TSX")).toBe("tsx");
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
  });
});

describe("the Material set", () => {
  test("different types get different pictures that keep their colours", () => {
    const typescript = iconForFile(material, "index.ts");
    const rust = iconForFile(material, "main.rs");
    expect(typescript.image).toContain("typescript.svg");
    expect(rust.image).toContain("rust.svg");
    expect(typescript.svg).toBeUndefined();
  });

  test("a well-known name wins over its extension", () => {
    expect(iconForFile(material, "package.json").image).not.toBe(iconForFile(material, "data.json").image);
    expect(iconForFile(material, "PACKAGE.JSON").image).toBe(iconForFile(material, "package.json").image);
  });

  test("an unknown type gets the plain file picture", () => {
    expect(iconForFile(material, "mystery.zzz")).toBe(material.file);
    expect(iconForFile(material, "NOEXTENSION")).toBe(material.file);
  });

  test("named folders have their own pictures, open and closed", () => {
    expect(iconForFolder(material, "src", false).image).toContain("folder-src.svg");
    expect(iconForFolder(material, "src", true).image).toContain("folder-src-open.svg");
    expect(iconForFolder(material, "anything", false)).toBe(material.folder);
    expect(iconForFolder(material, "anything", true)).toBe(material.folderOpen);
  });
});

describe("the monochrome set", () => {
  test("draws glyphs with no colour of their own", () => {
    const icon = iconForFile(monochrome, "index.ts");
    expect(icon.svg).toBeDefined();
    expect(icon.color).toBeUndefined();
    expect(icon.image).toBeUndefined();
    expect(iconForFile(monochrome, "mystery.zzz")).toBe(monochrome.file);
    expect(iconForFolder(monochrome, "src", false)).toBe(monochrome.folder);
  });
});
