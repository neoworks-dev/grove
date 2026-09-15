// The wire to the terminal daemon.
//
// Shell output is arbitrary bytes arriving in arbitrary chunks, so the two
// things worth pinning down are that a message survives the round trip whatever
// it contains, and that the decoder reassembles messages split across reads.

import { describe, expect, test } from 'bun:test'
import { encode, LineDecoder } from '../src/main/terminals/protocol'
import { Scrollback } from '../src/main/terminals/scrollback'

describe('framing', () => {
  test('a message survives encoding and decoding', () => {
    const decoder = new LineDecoder()
    const messages = decoder.push(encode({ type: 'write', id: 'term-1', data: 'ls -la\r' }))

    expect(messages).toEqual([{ type: 'write', id: 'term-1', data: 'ls -la\r' }])
  })

  test('newlines and escape sequences in output do not split a message', () => {
    const data = 'line one\nline two\r\n[2J[H'
    const decoder = new LineDecoder()
    const messages = decoder.push(encode({ type: 'data', id: 'term-1', data }))

    expect(messages).toEqual([{ type: 'data', id: 'term-1', data }])
  })

  test('a message split across reads is reassembled', () => {
    const wire = encode({ type: 'data', id: 'term-1', data: 'hello' })
    const decoder = new LineDecoder()

    const first = decoder.push(wire.slice(0, 12))
    const second = decoder.push(wire.slice(12))

    expect(first).toEqual([])
    expect(second).toEqual([{ type: 'data', id: 'term-1', data: 'hello' }])
  })

  test('several messages in one read all come back, in order', () => {
    const wire =
      encode({ type: 'data', id: 'a', data: '1' }) +
      encode({ type: 'data', id: 'b', data: '2' }) +
      encode({ type: 'data', id: 'c', data: '3' })

    const ids = new LineDecoder().push(wire).map((message) => (message as { id: string }).id)

    expect(ids).toEqual(['a', 'b', 'c'])
  })

  test('a line that is not JSON is dropped rather than thrown', () => {
    const decoder = new LineDecoder()
    const messages = decoder.push(`not json\n${encode({ type: 'kill', id: 'term-1' })}`)

    expect(messages).toEqual([{ type: 'kill', id: 'term-1' }])
  })
})

describe('scrollback', () => {
  test('keeps what was printed, in order', () => {
    const scrollback = new Scrollback()
    scrollback.append('one ')
    scrollback.append('two')

    expect(scrollback.text()).toBe('one two')
  })

  test('drops the oldest output once the cap is reached', () => {
    const scrollback = new Scrollback(10)
    scrollback.append('aaaaa')
    scrollback.append('bbbbb')
    scrollback.append('ccccc')

    expect(scrollback.text()).toBe('bbbbbccccc')
  })

  test('splits the chunk that straddles the cap rather than dropping it whole', () => {
    const scrollback = new Scrollback(6)
    scrollback.append('aaaaa')
    scrollback.append('bbb')

    expect(scrollback.text()).toBe('aaabbb')
  })

  test('a single chunk larger than the cap is trimmed to it', () => {
    const scrollback = new Scrollback(4)
    scrollback.append('abcdefgh')

    expect(scrollback.text()).toBe('efgh')
  })
})
