import { describe, expect, test } from "bun:test";
import { newComment } from "../plugins/review-comments/model";
import { CommentStore, commentsPath, parseComments, writeComments, type ReviewFiles } from "../plugins/review-comments/store";

/** Files held in memory, with the data directory Grove would use. */
class MemoryFiles implements ReviewFiles {
  files = new Map<string, string>();
  writes = 0;

  async dataDirectory(): Promise<string> {
    return "/data";
  }

  async readIfExists(path: string): Promise<string | null> {
    const text = this.files.get(path);
    if (text === undefined) {
      return null;
    }
    return text;
  }

  async writeText(path: string, text: string): Promise<void> {
    this.writes += 1;
    this.files.set(path, text);
  }
}

const comment = newComment("c1", "src/a.ts", { startRow: 2, endRow: 3 }, ["x", "y"], "Look at this.", 5);

describe("the saved review comments", () => {
  test("are one file in the data directory, with the comments of each worktree under its path", () => {
    expect(commentsPath("/data")).toBe("/data/review/comments.json");
    const parsed = JSON.parse(writeComments({ "/repo": [comment] }));
    expect(parsed.worktrees["/repo"][0].text).toBe("Look at this.");
  });

  test("come back as they were written, after a restart", async () => {
    const files = new MemoryFiles();
    await new CommentStore(files).save({ "/repo": [comment], "/other": [{ ...comment, id: "c2" }] });
    const restarted = new CommentStore(files);
    expect(await restarted.load()).toEqual({ "/repo": [comment], "/other": [{ ...comment, id: "c2" }] });
    expect(files.files.has("/data/review/comments.json")).toBe(true);
  });

  test("are none before anything was saved", async () => {
    expect(await new CommentStore(new MemoryFiles()).load()).toEqual({});
  });

  test("leave out what is damaged, and a file that is not ours gives none", () => {
    const damaged = JSON.stringify({ version: 1, worktrees: { "/repo": [comment, { id: 3 }, "x", { ...comment, quoted: "no" }], "/bad": "no" } });
    expect(parseComments(damaged)).toEqual({ "/repo": [comment] });
    expect(parseComments("not json")).toEqual({});
    expect(parseComments("[]")).toEqual({});
    expect(parseComments('{"worktrees": 4}')).toEqual({});
  });
});
