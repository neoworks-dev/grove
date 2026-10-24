import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import { Context as RootContext } from "@neoworks/extension-system";
import type { FileChange, LspHost, LspOptions, ToolProgress } from "../plugins/lsp/host";
import { entryFor, statusEntries, type ServerSummary } from "../plugins/lsp/servers";
import { LspService } from "../plugins/lsp/service";
import { settle } from "./support/fakeSidecar";

/** A server as the host describes it. */
function server(overrides: Partial<ServerSummary> = {}): ServerSummary {
  return { id: 1, name: "rust-analyzer", root: "/work/app", state: "ready", message: "", busy: null, ...overrides };
}

describe("how the status bar words a server", () => {
  test("a ready server is just its name, in the good colour", () => {
    expect(entryFor(server())).toEqual({
      id: 1,
      text: "rust-analyzer",
      tone: "good",
      restartable: false,
      action: null,
      detail: "/work/app",
    });
  });

  test("what a server is busy with follows its name", () => {
    const entry = entryFor(server({ busy: "Indexing: 12/300" }));
    expect(entry.text).toBe("rust-analyzer: Indexing: 12/300");
    expect(entry.tone).toBe("busy");
  });

  test("a server that is starting says so and cannot be pressed yet", () => {
    const entry = entryFor(server({ state: "starting" }));
    expect(entry.text).toBe("rust-analyzer starting…");
    expect(entry.restartable).toBe(false);
  });

  test("a crashed server can be started again and carries its last words", () => {
    const entry = entryFor(server({ state: "exited", message: "thread panicked" }));
    expect(entry.text).toBe("rust-analyzer stopped unexpectedly, press to restart");
    expect(entry.tone).toBe("bad");
    expect(entry.restartable).toBe(true);
    expect(entry.detail).toBe("thread panicked");
  });

  test("a server that could not start and one that is not installed say different things", () => {
    expect(entryFor(server({ state: "failed", message: "no such file" })).text).toBe(
      "rust-analyzer failed to start, press to restart",
    );
    const missing = entryFor(server({ state: "missing", message: "install it" }));
    expect(missing.text).toBe("rust-analyzer not installed");
    expect(missing.tone).toBe("quiet");
  });

  test("every server gets an entry, in order", () => {
    const entries = statusEntries([server({ id: 1 }), server({ id: 2, name: "typescript" })]);
    expect(entries.map((entry) => entry.text)).toEqual(["rust-analyzer", "typescript"]);
  });
});

/** The host's language servers, held in memory, that say what they are told. */
class FakeLspHost implements LspHost {
  servers: ServerSummary[] = [];
  restarted: number[] = [];
  configured: LspOptions[] = [];
  changed: FileChange[][] = [];
  installed: string[] = [];
  /** What `installTool` does: resolves by default, and a test swaps in a promise it controls. */
  installing: (id: string) => Promise<void> = async () => {};
  private handlers: ((servers: ServerSummary[]) => void)[] = [];
  private progressHandlers: ((progress: ToolProgress) => void)[] = [];

  async installTool(id: string): Promise<void> {
    this.installed.push(id);
    await this.installing(id);
  }

  onToolProgress(handler: (progress: ToolProgress) => void): () => void {
    this.progressHandlers.push(handler);
    return () => {
      this.progressHandlers = this.progressHandlers.filter((candidate) => candidate !== handler);
    };
  }

  /** Tells the service how an install is going, as the host's `tool-progress` event does. */
  progress(progress: ToolProgress): void {
    for (const handler of this.progressHandlers) {
      handler(progress);
    }
  }

  async status(): Promise<ServerSummary[]> {
    return this.servers;
  }

  async restart(id: number): Promise<void> {
    this.restarted.push(id);
  }

  async configure(options: LspOptions): Promise<void> {
    this.configured.push(options);
  }

  async filesChanged(changes: FileChange[]): Promise<void> {
    this.changed.push(changes);
  }

  onStatus(handler: (servers: ServerSummary[]) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((candidate) => candidate !== handler);
    };
  }

  /** Tells the service the servers changed, as the host's `lsp-status` event does. */
  announce(servers: ServerSummary[]): void {
    this.servers = servers;
    for (const handler of this.handlers) {
      handler(servers);
    }
  }
}

async function setUp(host: LspHost): Promise<LspService> {
  const root = new RootContext();
  let service!: LspService;
  await root.plugin({
    name: "lsp-test",
    apply: (ctx: Context) => {
      service = new LspService(ctx, host);
    },
  });
  return service;
}

describe("the lsp service", () => {
  test("starts from what the host says and follows its status events", async () => {
    const host = new FakeLspHost();
    host.servers = [server({ state: "starting" })];
    const service = await setUp(host);
    await settle();
    expect(service.entries().map((entry) => entry.text)).toEqual(["rust-analyzer starting…"]);
    host.announce([server({ state: "ready" })]);
    expect(service.entries().map((entry) => entry.text)).toEqual(["rust-analyzer"]);
    host.announce([]);
    expect(service.entries()).toEqual([]);
  });

  test("restarting asks the host to start that server again", async () => {
    const host = new FakeLspHost();
    const service = await setUp(host);
    await service.restart(7);
    expect(host.restarted).toEqual([7]);
  });

  test("a host that cannot say leaves the list empty", async () => {
    const host = new FakeLspHost();
    host.status = () => Promise.reject(new Error("no host"));
    const service = await setUp(host);
    await settle();
    expect(service.servers()).toEqual([]);
  });
});

describe("telling the host about the settings and the files that change", () => {
  test("the switches of the language features go to the host as they are", async () => {
    const host = new FakeLspHost();
    const service = await setUp(host);
    await service.configure({ inlayHints: false, formatOnSave: true, eslint: false });
    expect(host.configured).toEqual([{ inlayHints: false, formatOnSave: true, eslint: false }]);
  });

  test("a burst of watched changes reaches the host as one message of absolute paths", async () => {
    const host = new FakeLspHost();
    const service = await setUp(host);
    service.noteWatchedChange("/work/app", { relPath: "src/a.ts", type: "change" });
    service.noteWatchedChange("/work/app", { relPath: "src/b.ts", type: "add" });
    service.noteWatchedChange("/work/app", { relPath: "src/old.ts", type: "unlink" });
    service.noteWatchedChange("/work/app", { relPath: "src", type: "addDir" });
    expect(host.changed).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(host.changed).toEqual([
      [
        { path: "/work/app/src/a.ts", kind: "changed" },
        { path: "/work/app/src/b.ts", kind: "created" },
        { path: "/work/app/src/old.ts", kind: "deleted" },
      ],
    ]);
  });

  test("changes to directories alone tell the host nothing", async () => {
    const host = new FakeLspHost();
    const service = await setUp(host);
    service.noteWatchedChange("/work/app", { relPath: "src", type: "unlinkDir" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(host.changed).toEqual([]);
  });
});

describe("installing a server that is not installed", () => {
  const missing = (overrides: Partial<ServerSummary> = {}) =>
    server({ id: 4, name: "taplo", state: "missing", message: "taplo was not found", tool: "taplo", ...overrides });

  test("a missing server Grove has a recipe for offers to install it", () => {
    const entry = entryFor(missing());
    expect(entry).toMatchObject({ text: "taplo not installed, press to install", tone: "quiet", action: "install", restartable: true });
  });

  test("a missing server with no recipe only says it is not installed", () => {
    expect(entryFor(missing({ tool: null }))).toMatchObject({ text: "taplo not installed", action: "restart" });
    expect(entryFor(missing({ tool: undefined }))).toMatchObject({ text: "taplo not installed", action: "restart" });
  });

  test("shows each step while it installs, then starts the server when it is in place", async () => {
    const host = new FakeLspHost();
    host.servers = [missing()];
    let finish!: () => void;
    host.installing = () => new Promise<void>((resolve) => (finish = resolve));
    const service = await setUp(host);
    await settle();

    const running = service.install(4);
    expect(host.installed).toEqual(["taplo"]);
    expect(service.entries()[0]).toMatchObject({ text: "Installing taplo: Starting", tone: "busy", action: null });
    host.progress({ id: "taplo", phase: "output", message: "Downloading taplo-linux-x86_64.gz" });
    expect(service.entries()[0].text).toBe("Installing taplo: Downloading taplo-linux-x86_64.gz");
    host.progress({ id: "taplo", phase: "output", message: "Compiling a crate with a very long name indeed" });
    expect(service.entries()[0].text).toBe("Installing taplo: Compiling a crate with a very long …");
    expect(service.entries()[0].detail).toBe("Compiling a crate with a very long name indeed");

    await service.install(4);
    expect(host.installed).toEqual(["taplo"]);
    finish();
    await running;
    expect(host.restarted).toEqual([4]);
    expect(service.entries()[0].text).toBe("taplo not installed, press to install");
  });

  test("a failed install says why and pressing again tries again", async () => {
    const host = new FakeLspHost();
    host.servers = [missing()];
    host.installing = async () => {
      throw new Error("GitHub is limiting requests");
    };
    const service = await setUp(host);
    await settle();

    await service.install(4);
    expect(service.entries()[0]).toMatchObject({ text: "taplo install failed, press to retry", tone: "bad", action: "install", detail: "GitHub is limiting requests" });
    expect(host.restarted).toEqual([]);

    host.installing = async () => {};
    await service.install(4);
    expect(host.installed).toEqual(["taplo", "taplo"]);
    expect(host.restarted).toEqual([4]);
  });

  test("installing a server that has no tool does nothing", async () => {
    const host = new FakeLspHost();
    host.servers = [missing({ tool: null })];
    const service = await setUp(host);
    await settle();
    await service.install(4);
    expect(host.installed).toEqual([]);
  });
});
