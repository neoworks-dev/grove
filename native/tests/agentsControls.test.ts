import { expect, test } from "bun:test";
import { approvalsChoices, modeLine, modelLine, usageLine } from "../plugins/agents/composerControls";
import { initialStatus } from "../plugins/agents/status";

test("the approvals dropdown lists the modes in the order Shift-Tab cycles", () => {
  expect(approvalsChoices().map((choice) => choice.value)).toEqual(["ask", "review", "edits", "auto"]);
  expect(modeLine("review")).toBe("Review mode");
});

test("the usage line names the parts it knows", () => {
  const status = initialStatus();
  expect(usageLine(status)).toBe("");
  expect(usageLine({ ...status, usage: { type: "usage", contextUsed: 32000, contextSize: 200000, cost: 0.05 } })).toBe("32.0k · 16% · $0.05");
  expect(usageLine({ ...status, usage: { type: "usage", cost: 1.2 } })).toBe("$1.20");
});

test("the model line is the harness's model and effort, as far as they were set", () => {
  const status = { ...initialStatus(), harness: "claude", settings: { claude: { model: "sonnet", effort: "high" }, pi: { model: "other" } } };
  expect(modelLine(status)).toBe("sonnet · high");
  expect(modelLine(initialStatus())).toBe("");
});
