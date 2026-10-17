// The real suite host: the daemon's address and start-up come from the Rust host's commands
// (`src/suite.rs`), and the connection is the suite's own TypeScript client, which talks to the
// daemon over the WebSocket the host provides. The only file that imports `@suite/sdk` at run time.

import { invoke } from "@neoworks/svelte-gpui";
import { assetUrl, connect } from "@suite/sdk";
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
        waitForDaemon: true,
        onError: options.onError,
      });
    },
    assetUrl(address: DaemonAddress, source: string) {
      return assetUrl(address, source);
    },
  };
}
