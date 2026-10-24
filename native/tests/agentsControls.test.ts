import { expect, test } from "bun:test";
import { approvalsChoices, approvalsIcon, harnessChoices, harnessLabel, modeLine, optionChoices, optionLabel, usageLine } from "../plugins/agents/composerControls";
import { initialStatus } from "../plugins/agents/status";

test("the approvals dropdown lists the modes in the order Shift-Tab cycles", () => {
  expect(approvalsChoices().map((choice) => choice.value)).toEqual(["ask", "review", "edits", "auto"]);
  expect(modeLine("review")).toBe("Review mode");
});

test("every approvals mode has an icon of its own, in the dropdown and on its button", () => {
  const choices = approvalsChoices();
  expect(new Set(choices.map((choice) => choice.icon)).size).toBe(choices.length);
  for (const choice of choices) {
    expect(choice.icon.length).toBeGreaterThan(0);
    expect(approvalsIcon(choice.value)).toBe(choice.icon);
  }
});

test("the usage line names the parts it knows", () => {
  const status = initialStatus();
  expect(usageLine(status)).toBe("");
  expect(usageLine({ ...status, usage: { type: "usage", contextUsed: 32000, contextSize: 200000, cost: 0.05 } })).toBe("32.0k · 16% · $0.05");
  expect(usageLine({ ...status, usage: { type: "usage", cost: 1.2 } })).toBe("$1.20");
});

const offered = [
  { name: "neo", title: "neo", current: false, options: [] },
  {
    name: "claude",
    title: "Claude Code",
    current: true,
    options: [
      { category: "model" as const, current: "sonnet", values: [{ value: "haiku", name: "Haiku 4.5" }, { value: "sonnet", name: "Sonnet 4.5" }] },
      { category: "thought_level" as const, values: [{ value: "high", name: "high" }] },
    ],
  },
];

test("harnesses show by their titles, capitalized", () => {
  expect(harnessChoices(offered, "claude").map(({ value, label }) => ({ value, label }))).toEqual([
    { value: "neo", label: "Neo" },
    { value: "claude", label: "Claude Code" },
  ]);
  expect(harnessChoices([], "pi")[0].label).toBe("Pi");
  expect(harnessLabel(offered, "codex")).toBe("Codex");
});

test("models and efforts show by the harness's names for them", () => {
  expect(optionChoices(offered, "claude", "model").map((choice) => choice.label)).toEqual(["Haiku 4.5", "Sonnet 4.5"]);
  expect(optionLabel(offered, "claude", "model", "haiku")).toBe("Haiku 4.5");
  expect(optionLabel(offered, "claude", "model", undefined)).toBe("Sonnet 4.5");
  expect(optionLabel(offered, "claude", "thought_level", "high")).toBe("High");
  expect(optionLabel(offered, "claude", "thought_level", undefined)).toBeUndefined();
  expect(optionLabel([], "pi", "model", "openrouter/x")).toBe("Openrouter/x");
});
