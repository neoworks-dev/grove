import { describe, expect, test } from "bun:test";
import { Context } from "@neoworks/extension-system";
import { SidecarService, SidecarUnavailableError } from "../plugins/sidecar/service";
import { bootSidecar, settle } from "./support/fakeSidecar";

describe("SidecarService status", () => {
  test("is starting until the sidecar has answered, then running", async () => {
    const harness = await bootSidecar();
    expect(harness.sidecar.status().state).toBe("running");

    const root = new Context();
    const link = harness.link;
    const release = link.holdStart();
    let slow!: SidecarService;
    await root.plugin({ name: "slow", apply: (ctx: Context) => void (slow = new SidecarService(ctx, link)) });
    await settle();
    expect(slow.status().state).toBe("starting");
    expect(slow.isRunning()).toBe(false);
    release();
    await settle();
    expect(slow.status().state).toBe("running");
  });

  test("is exited with the host's message when the sidecar never started", async () => {
    const root = new Context();
    const harness = await bootSidecar();
    harness.link.hostStatus = { state: "exited", message: "could not start bun" };
    let service!: SidecarService;
    await root.plugin({ name: "down", apply: (ctx: Context) => void (service = new SidecarService(ctx, harness.link)) });
    await settle();
    expect(service.status()).toEqual({ state: "exited", message: "could not start bun" });
  });

  test("becomes exited when the sidecar ends, and stays exited", async () => {
    const harness = await bootSidecar();
    harness.link.exit("the sidecar exited with code 1");
    expect(harness.sidecar.status()).toEqual({ state: "exited", message: "the sidecar exited with code 1" });
    expect(harness.sidecar.isRunning()).toBe(false);
  });
});

describe("SidecarService calls", () => {
  test("a call goes through to the route while the sidecar runs", async () => {
    const harness = await bootSidecar({ "files:listDir": (worktreeId, rel) => [worktreeId, rel] });
    expect(await harness.sidecar.call("files:listDir", "w", "src")).toEqual(["w", "src"]);
  });

  test("the workbench object calls the same routes", async () => {
    const harness = await bootSidecar({ "repo:last": () => "/work/repo" });
    expect(await harness.sidecar.workbench.repo.last()).toBe("/work/repo");
  });

  test("a call made while the sidecar is down rejects instead of reaching it", async () => {
    const harness = await bootSidecar({ "repo:last": () => "/work/repo" });
    harness.link.exit("gone");
    await expect(harness.sidecar.call("repo:last")).rejects.toBeInstanceOf(SidecarUnavailableError);
    await expect(harness.sidecar.workbench.repo.last()).rejects.toThrow("the sidecar is not running: gone");
    expect(harness.link.channelsCalled()).toEqual([]);
  });

  test("a call made while the sidecar is starting waits for it", async () => {
    const harness = await bootSidecar();
    const root = new Context();
    const release = harness.link.holdStart();
    harness.link.routes["ping"] = () => "pong";
    let slow!: SidecarService;
    await root.plugin({ name: "slow", apply: (ctx: Context) => void (slow = new SidecarService(ctx, harness.link)) });
    await settle();
    const answer = slow.call("ping");
    release();
    expect(await answer).toBe("pong");
  });
});

describe("SidecarService events", () => {
  test("a listener hears the sidecar's events", async () => {
    const harness = await bootSidecar();
    const heard: unknown[] = [];
    harness.sidecar.on("event:fs-change", (payload) => heard.push(payload));
    harness.link.emit("event:fs-change", { relPath: "a.ts" });
    expect(heard).toEqual([{ relPath: "a.ts" }]);
  });

  test("a listener leaves with the plugin that added it", async () => {
    const harness = await bootSidecar();
    const heard: unknown[] = [];
    const fiber = harness.root.plugin({
      name: "listener",
      inject: ["sidecar"],
      apply(ctx: Context) {
        ctx.sidecar.on("event:fs-change", (payload) => heard.push(payload));
      },
    });
    await fiber;
    expect(harness.link.listenerCount("event:fs-change")).toBe(1);
    await fiber.dispose();
    expect(harness.link.listenerCount("event:fs-change")).toBe(0);
    harness.link.emit("event:fs-change", {});
    expect(heard).toEqual([]);
  });
});
