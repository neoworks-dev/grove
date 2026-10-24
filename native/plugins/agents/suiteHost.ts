// The real suite host: the daemon's address and start-up come from the Rust host's commands
// (`src/suite.rs`), and the connection is the suite's own TypeScript client, which talks to the
// daemon over the WebSocket the host provides. The only file that imports `@suite/sdk` at run time.

import { invoke, listen } from "@neoworks/svelte-gpui";
import type { McpEndpoint } from "@suite/protocol/types";
import { assetUrl, connect } from "@suite/sdk";
import type { AppTool, ToolServer } from "./contributions";
import type { DaemonAddress, SuiteConnectOptions, SuiteHost } from "./suiteClient";

/** The suite host for the running app. */
export function createSuiteHost(): SuiteHost {
  return {
    async address() {
      return invoke<{ url: string; token: string }>("suite_address");
    },
    async startDaemon() {
      await invoke("suite_up");
    },
    connect(options: SuiteConnectOptions) {
      return connect({
        client: options.client,
        address: options.address,
        // The service starts the daemon and bounds the wait itself: a daemon that accepts the
        // connection and never answers must end as an error, not as a retry that never stops.
        waitForDaemon: false,
        requestTimeoutMs: options.requestTimeoutMs,
        onError: options.onError,
      });
    },
    assetUrl(address: DaemonAddress, source: string) {
      return assetUrl(address, source);
    },
    toolServer: createToolServer,
  };
}

/** A call from the gateway, as the host's tool server hands it over. */
interface ToolCall {
  id: number;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * The tool server of the Rust host (`src/tools.rs`): it listens on the loopback address and
 * emits each call as the event `tool-call`, which this runs and answers with `tools_result`.
 */
export function createToolServer(): ToolServer {
  let tools: readonly AppTool[] = [];
  let listening = false;
  return {
    async serve(next) {
      tools = next;
      if (!listening) {
        listening = true;
        listen<ToolCall>("tool-call", (call) => void answerCall(call, () => tools));
        await invoke("tools_start");
      }
      const listed = next.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
      return invoke<McpEndpoint>("tools_set", { tools: listed });
    },
  };
}

/** Runs the tool a call names and sends the host its text, or the reason it failed. */
async function answerCall(call: ToolCall, currentTools: () => readonly AppTool[]): Promise<void> {
  const tool = currentTools().find((candidate) => candidate.name === call.name);
  if (tool === undefined) {
    await invoke("tools_result", { id: call.id, text: `no tool ${call.name}`, isError: true });
    return;
  }
  try {
    const text = await tool.run(call.arguments);
    await invoke("tools_result", { id: call.id, text });
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) {
      message = error.message;
    }
    await invoke("tools_result", { id: call.id, text: message, isError: true });
  }
}
