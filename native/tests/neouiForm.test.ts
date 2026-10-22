import { expect, test } from "bun:test";
import {
  dateParts,
  dateText,
  flip,
  groupHas,
  isDate,
  Outbox,
  pick,
  same,
  sendable,
  share,
  sliderAt,
  snap,
  textOf,
  weekday,
} from "../plugins/agents/chat/openui/form";
import {
  MONTHS,
  monthGrid,
  shiftMonth,
  WEEKDAYS,
} from "../plugins/agents/chat/openui/calendar";

type Sent = { ref: string; action: string; args: unknown };

function rig(): {
  box: Outbox;
  sent: Sent[];
  send: (ref: string, action: string, args: unknown) => void;
} {
  const sent: Sent[] = [];
  return {
    box: new Outbox(),
    sent,
    send: (ref, action, args) => void sent.push({ ref, action, args }),
  };
}

test("a field shows a string or a number and nothing else", () => {
  expect(textOf("a")).toBe("a");
  expect(textOf(12)).toBe("12");
  expect(textOf(true)).toBe("");
  expect(textOf(undefined)).toBe("");
  expect(textOf({})).toBe("");
});

test("values are the same as the daemon sees them", () => {
  expect(same(10, 10)).toBe(true);
  expect(same("a", "a")).toBe(true);
  expect(same(["a", "b"], ["a", "b"])).toBe(true);
  expect(same({ a: true }, { a: true })).toBe(true);
  expect(same(["a"], ["b"])).toBe(false);
  expect(same("1", 1)).toBe(false);
  expect(same(null, undefined)).toBe(false);
});

test("a date is a calendar date in YYYY-MM-DD", () => {
  expect(isDate("2026-10-20")).toBe(true);
  expect(isDate("2024-02-29")).toBe(true);
  expect(isDate("2026-02-29")).toBe(false);
  expect(isDate("2026-13-01")).toBe(false);
  expect(isDate("2026-4-01")).toBe(false);
  expect(isDate("2026-04-31")).toBe(false);
  expect(isDate("")).toBe(false);
  expect(dateText(2026, 4, 5)).toBe("2026-04-05");
  expect(dateParts("2026-04-05")).toEqual({ year: 2026, month: 4, day: 5 });
  expect(dateParts("2026-4-5")).toBeUndefined();
  // 2026-10-20 is a Tuesday: Monday is 0.
  expect(weekday(2026, 10, 20)).toBe(1);
  expect(weekday(2026, 10, 18)).toBe(6);
});

test("typed text goes to the daemon, and a date only when it is one or empty", () => {
  expect(sendable("text", "anything")).toBe(true);
  expect(sendable("date", "")).toBe(true);
  expect(sendable("date", "2026-10-2")).toBe(false);
  expect(sendable("date", "2026-10-20")).toBe(true);
});

test("a slider value snaps to its step from min and is held to the range", () => {
  expect(snap(3.4, 0, 10, 1)).toBe(3);
  expect(snap(3.6, 0, 10, 1)).toBe(4);
  expect(snap(-5, 0, 10, 1)).toBe(0);
  expect(snap(99, 0, 10, 1)).toBe(10);
  expect(snap(7, 1, 10, 2)).toBe(7);
  expect(snap(6, 1, 10, 2)).toBe(7);
  expect(snap(0.30000000000000004, 0, 1, 0.1)).toBe(0.3);
  expect(snap(5, 0, 10, 0)).toBe(5);
  expect(sliderAt(50, 100, 0, 10, 1)).toBe(5);
  expect(sliderAt(-20, 100, 0, 10, 1)).toBe(0);
  expect(sliderAt(500, 100, 0, 10, 1)).toBe(10);
  expect(sliderAt(10, 0, 3, 10, 1)).toBe(3);
  expect(share(5, 0, 10)).toBe(0.5);
  expect(share(5, 5, 5)).toBe(0);
});

test("left and right pick the neighbouring option and stop at the ends", () => {
  const options = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
    { value: "c", label: "C" },
  ];
  expect(pick(options, "a", 1)).toBe("b");
  expect(pick(options, "c", 1)).toBe("c");
  expect(pick(options, "a", -1)).toBe("a");
  // Nothing chosen yet: the first going on, the last going back.
  expect(pick(options, "", 1)).toBe("a");
  expect(pick(options, "", -1)).toBe("c");
  expect(pick([], "", 1)).toBeUndefined();
});

test("toggling an item of a group sends the list in the items' order or the object of every item", () => {
  const items = [
    { name: "ci", label: "CI" },
    { name: "sso", label: "SSO" },
    { name: "audit", label: "Audit" },
  ];
  expect(flip(["audit"], items, "ci", false)).toEqual(["ci", "audit"]);
  expect(flip(["ci", "audit"], items, "ci", false)).toEqual(["audit"]);
  expect(flip(undefined, items, "sso", false)).toEqual(["sso"]);
  expect(flip({ ci: true }, items, "sso", true)).toEqual({ ci: true, sso: true, audit: false });
  expect(flip({ ci: true }, items, "ci", true)).toEqual({ ci: false, sso: false, audit: false });
  expect(groupHas(["a"], "a")).toBe(true);
  expect(groupHas({ a: false }, "a")).toBe(false);
  expect(groupHas(null, "a")).toBe(false);
});

test("typing is sent after a pause and the latest text replaces an earlier one", async () => {
  const { box, sent, send } = rig();
  box.queue("m-1", { doc: "0", key: "name", value: "a" }, 20, send);
  box.queue("m-1", { doc: "0", key: "name", value: "ab" }, 20, send);
  expect(sent).toEqual([]);
  expect(box.waiting).toBe(true);
  await Bun.sleep(60);
  expect(sent).toEqual([
    { ref: "m-1", action: "openui.input", args: { doc: "0", key: "name", value: "ab" } },
  ]);
  expect(box.waiting).toBe(false);
});

test("a value that is not typing goes at once and takes the place of one that waits", async () => {
  const { box, sent, send } = rig();
  box.queue("m-1", { doc: "0", key: "n", value: 1 }, 20, send);
  box.queue("m-1", { doc: "0", key: "n", value: 2 }, 0, send);
  expect(sent.map((s) => s.args)).toEqual([{ doc: "0", key: "n", value: 2 }]);
  await Bun.sleep(50);
  expect(sent).toHaveLength(1);
});

test("a press sends what waits for its doc first, and nothing of another doc", () => {
  const { box, sent, send } = rig();
  box.queue("m-1", { doc: "0", key: "name", value: "ada" }, 1000, send);
  box.queue("m-1", { doc: "1", key: "other", value: "x" }, 1000, send);
  box.queue("m-2", { doc: "0", key: "name", value: "y" }, 1000, send);
  box.press("m-1", "0", "go", send);
  expect(sent.map((s) => [s.ref, s.action, s.args])).toEqual([
    ["m-1", "openui.input", { doc: "0", key: "name", value: "ada" }],
    ["m-1", "openui.press", { doc: "0", key: "go" }],
  ]);
  // The others still wait; flushing one field leaves the rest.
  expect(box.waiting).toBe(true);
  box.flush("m-1", "1", "other");
  expect(sent).toHaveLength(3);
  box.flush("m-2", "0");
  expect(sent).toHaveLength(4);
  expect(box.waiting).toBe(false);
});

test("a month is weeks of seven days from Monday, and the arrows roll over the year", () => {
  // October 2026 starts on a Thursday.
  const weeks = monthGrid(2026, 10);
  expect(weeks).toHaveLength(5);
  expect(weeks.every((week) => week.length === 7)).toBe(true);
  expect(weeks[0]).toEqual([undefined, undefined, undefined, 1, 2, 3, 4]);
  expect(weeks[4]?.slice(0, 5)).toEqual([26, 27, 28, 29, 30]);
  expect(weeks.flat().filter((day) => day !== undefined)).toHaveLength(31);
  // February 2026 is exactly four weeks, starting on a Sunday: six leading blanks.
  expect(monthGrid(2026, 2)[0]?.[6]).toBe(1);
  expect(
    monthGrid(2024, 2)
      .flat()
      .filter((day) => day !== undefined),
  ).toHaveLength(29);
  expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  expect(shiftMonth(2026, 5, 0)).toEqual({ year: 2026, month: 5 });
  expect(WEEKDAYS).toHaveLength(7);
  expect(MONTHS[9]).toBe("October");
});
