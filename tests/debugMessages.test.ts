// A failed debugger call reaches the renderer wrapped by Electron's IPC; the
// UI shows only what the adapter or the service said.

import { describe, expect, test } from 'bun:test'
import { messageOf } from '../src/renderer/src/kernel/plugins/debug/messages'

describe('messageOf', () => {
  test("drops Electron's prefix and the error's class name", () => {
    expect(
      messageOf(
        new Error(
          "Error invoking remote method 'debug:evaluate': DapRequestError: name 'value' is not defined"
        )
      )
    ).toBe("name 'value' is not defined")
    expect(
      messageOf(
        new Error("Error invoking remote method 'debug:start': Error: debugpy is not installed")
      )
    ).toBe('debugpy is not installed')
    expect(messageOf('plain')).toBe('plain')
    expect(messageOf(42)).toBe('unknown error')
  })
})
