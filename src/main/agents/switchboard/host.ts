// The one switchboard every harness runs on.
//
// switchboard (`@neoworks/harness`) spawns Claude Code, Codex and pi as child
// processes and pools them, so grove keeps a single instance for the life of the
// app, beside the MCP server that serves grove's tools to all of them.

import type { Harness } from '@neoworks/harness'
import { GroveMcpServer } from './mcpServer'

export class SwitchboardHost {
  private harness: Promise<Harness> | null = null
  readonly toolServer = new GroveMcpServer()

  /**
   * switchboard, started on first use. It ships as ESM only and main is
   * bundled as CommonJS, so it is loaded with a dynamic import.
   */
  switchboard(): Promise<Harness> {
    if (!this.harness) {
      // An empty config keeps the user's own `~/.config/neoworks/harness.json`
      // out of it: which harness a session runs on is grove's to say.
      this.harness = import('@neoworks/harness').then(({ createHarness }) => createHarness({}))
    }
    return this.harness
  }

  /** Stop every harness process and the tool server. */
  async close(): Promise<void> {
    this.toolServer.close()
    const harness = this.harness
    this.harness = null
    if (!harness) return
    await (await harness).close()
  }
}
