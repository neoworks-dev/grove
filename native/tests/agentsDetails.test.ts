import { describe, expect, test } from "bun:test";
import type { ConnectorInfo } from "@suite/protocol/types";
import { detailsOf, grouped, serversOf, shortened } from "../plugins/agents/details";
import { setUpAgents } from "./support/agentsSetup";
import { sessionInfo } from "./support/fakeSuite";
import { settle } from "./support/fakeSidecar";

/** A connector as the daemon lists it. */
function connector(app: string, kind: ConnectorInfo["kind"], connected: boolean, error?: string): ConnectorInfo {
  const info: ConnectorInfo = { app, kind, connected, v: 1, tools: [] };
  if (error !== undefined) {
    info.error = error;
  }
  return info;
}

describe("the shown session's details", () => {
  test("numbers are grouped in thousands and the home directory is a tilde", () => {
    expect(grouped(1234567)).toBe("1,234,567");
    expect(grouped(12)).toBe("12");
    expect(grouped(-1500)).toBe("-1,500");
    expect(shortened("/home/me/work/app", "/home/me")).toBe("~/work/app");
    expect(shortened("/home/me", "/home/me")).toBe("~");
    expect(shortened("/srv/app", "/home/me")).toBe("/srv/app");
  });

  test("the context share, the tokens and the cost are said where the agent reported them", () => {
    const details = detailsOf(
      "/home/me/app",
      "/home/me",
      { type: "usage", contextUsed: 70_000, contextSize: 100_000, inputTokens: 123_456, outputTokens: 789, cost: 0.426 },
      [],
    );
    expect(details).toEqual({
      directory: "~/app",
      context: { percent: 70, used: 70_000, size: 100_000, tone: "accent" },
      tokens: "in 123,456 · out 789",
      cost: "$0.43",
      servers: [],
    });
    expect(detailsOf("/a", undefined, { type: "usage", contextUsed: 90, contextSize: 100 }, []).context?.tone).toBe("danger");
    expect(detailsOf("/a", undefined, undefined, [])).toEqual({ directory: "/a", servers: [] });
  });

  test("only the service connectors are servers, by name, and a connector with an error is down", () => {
    expect(
      serversOf([connector("terminal", "app", true), connector("mcp-b", "service", true), connector("lsp", "service", true), connector("mcp-a", "service", false, "refused")]),
    ).toEqual([
      { name: "lsp", up: true },
      { name: "mcp-a", up: false, error: "refused" },
      { name: "mcp-b", up: true },
    ]);
  });
});

describe("the session list", () => {
  test("follows the connectors the daemon lists, and drops a session the daemon says was removed", async () => {
    const { host, agents } = await setUpAgents();
    await agents.ensureStarted();
    host.client.connectors.set([connector("lsp", "service", true)]);
    expect(agents.connectors().map((entry) => entry.app)).toEqual(["lsp"]);
    host.client.sessions.set([sessionInfo({ id: "a" }), sessionInfo({ id: "b" })]);
    await settle();
    expect(agents.sessions().map((session) => session.id)).toEqual(["a", "b"]);
    host.client.sessions.set([sessionInfo({ id: "b" })]);
    await settle();
    expect(agents.sessions().map((session) => session.id)).toEqual(["b"]);
  });
});

describe("secret questions", () => {
  test("the daemon's question is kept for its session until answered, and the answer goes only to the daemon", async () => {
    const { host, agents } = await setUpAgents();
    await agents.ensureStarted();
    host.client.askSecret({ id: "q1", session: "a", title: "DeepSeek API key", placeholder: "sk-…" });
    expect(agents.secretRequestFor("a")?.title).toBe("DeepSeek API key");
    expect(agents.secretRequestFor("b")).toBeUndefined();
    agents.answerSecret("q1", "sk-secret");
    expect(host.client.secretAnswers).toEqual([{ id: "q1", value: "sk-secret" }]);
    expect(agents.secretRequestFor("a")).toBeUndefined();
  });

  test("giving up answers with no value", async () => {
    const { host, agents } = await setUpAgents();
    await agents.ensureStarted();
    host.client.askSecret({ id: "q2", session: "a", title: "Code" });
    agents.answerSecret("q2");
    expect(host.client.secretAnswers).toEqual([{ id: "q2" }]);
  });
});
