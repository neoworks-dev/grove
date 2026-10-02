// Telling the agent terminal's answers to terminal queries apart from typing.

import { describe, expect, test } from 'bun:test'
import { isTerminalReply } from '../src/renderer/src/lib/agents/terminalReplies'

describe('terminal replies', () => {
  test('answers to what programs ask a terminal are replies', () => {
    for (const reply of ['\u001b[?1;2c', '\u001b[>0;276;0c', '\u001b[12;1R', '\u001b[0n', '\u001b[?2004;1$y', '\u001b]11;rgb:1e1e/1e1e/1e1e\u001b\\', '\u001bP1+r696e646e\u001b\\']) {
      expect(isTerminalReply(reply)).toBe(true)
    }
  })

  test('keys are not, escape sequences included', () => {
    for (const key of ['y', 'yes\r', '\u0003', '\u0004', '\u001b', '\u001b[A', '\u001b[1;5C', '\u001b[200~pasted\u001b[201~', '\u001bOP']) {
      expect(isTerminalReply(key)).toBe(false)
    }
  })
})
