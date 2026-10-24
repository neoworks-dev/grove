import { expect, test } from "bun:test";
import { ChatSession } from "../plugins/agents/chatSession";
import { FakeClient } from "./support/fakeSuite";

test("a session's history is folded in once its replay is over, not event by event", async () => {
  const client = new FakeClient();
  const chat = new ChatSession(client as never, "s", () => undefined);
  chat.start();
  const subscription = client.events[0];
  for (let index = 0; index < 500; index++) {
    subscription.emit({ type: "user_message", app: "grove", text: `message ${index}` });
    subscription.emit({ type: "turn_ended", reason: "end_turn" } as never);
  }
  subscription.emit({ type: "user_message", app: "grove", text: "the last one" });
  expect(chat.running()).toBe(false);

  await Promise.resolve();
  expect(chat.running()).toBe(true);

  subscription.emit({ type: "turn_ended", reason: "end_turn" } as never);
  expect(chat.running()).toBe(false);
});
