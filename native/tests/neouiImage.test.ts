import { expect, test } from "bun:test";
import {
  downloaded,
  galleryParts,
  pictureName,
  sourceOf,
} from "../plugins/agents/chat/openui/image";

test("a picture comes from an asset handle, a web address, a path or a data URL", () => {
  expect(sourceOf("asset://img-7f3a91c2d4e5", "/w")).toEqual({
    kind: "asset",
    handle: "asset://img-7f3a91c2d4e5",
  });
  expect(sourceOf("https://example.com/a.png", "/w")).toEqual({
    kind: "web",
    url: "https://example.com/a.png",
  });
  expect(sourceOf("HTTP://example.com/a.png", "/w").kind).toBe("web");
  expect(sourceOf("data:image/png;base64,AAAA", "/w").kind).toBe("data");
  expect(sourceOf("/tmp/a.png", "/w")).toEqual({ kind: "file", path: "/tmp/a.png" });
  expect(sourceOf("file:///tmp/a.png", "/w")).toEqual({ kind: "file", path: "/tmp/a.png" });
});

test("a relative path is the session's directory's", () => {
  expect(sourceOf("shots/a.png", "/work/app")).toEqual({
    kind: "file",
    path: "/work/app/shots/a.png",
  });
  expect(sourceOf("./a.png", "/work/app/")).toEqual({ kind: "file", path: "/work/app/a.png" });
});

test("a picture is named by its alt text, else by the last part of its address", () => {
  expect(pictureName("/tmp/a.png", "  A   cat\n")).toBe("A cat");
  expect(pictureName("/tmp/a.png", undefined)).toBe("a.png");
  expect(pictureName("https://example.com/x/b.webp?size=2#top", "")).toBe("b.webp");
  expect(pictureName("", undefined)).toBe("");
});

test("a gallery shows the first picture large, three more small and counts the rest", () => {
  expect(galleryParts([1, 2, 3, 4, 5, 6])).toEqual({ large: 1, small: [2, 3, 4], more: 2 });
  expect(galleryParts([1, 2])).toEqual({ large: 1, small: [2], more: 0 });
  expect(galleryParts([])).toEqual({ large: undefined, small: [], more: 0 });
});

test("a web address is downloaded once, and a failure may be tried again", async () => {
  const asked: string[] = [];
  const ok = (url: string): Promise<string> => {
    asked.push(url);
    return Promise.resolve(`asset://${url.length}`);
  };
  const [a, b] = await Promise.all([
    downloaded("https://x/1.png", ok),
    downloaded("https://x/1.png", ok),
  ]);
  expect(a).toBe(b);
  expect(asked).toEqual(["https://x/1.png"]);

  let tries = 0;
  const flaky = (): Promise<string> => {
    tries += 1;
    return tries === 1 ? Promise.reject(new Error("HTTP 500")) : Promise.resolve("asset://ok");
  };
  const failed = await downloaded("https://x/2.png", flaky).catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(Error);
  await Bun.sleep(1);
  expect(await downloaded("https://x/2.png", flaky)).toBe("asset://ok");
});
