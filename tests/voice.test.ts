// The pure half of dictation: which key is the dictation key, how float samples
// become the 16-bit PCM the endpoint reads, and how an IPC failure is worded for
// the user.

import { describe, expect, test } from 'bun:test'
import {
  describeVoiceError,
  floatToPcm16,
  isDictationSpace,
  spliceDictation
} from '../src/renderer/src/lib/voice'

/** A keyboard event carrying only the fields the helpers read. */
function keyEvent(fields: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    ...fields
  } as KeyboardEvent
}

describe('isDictationSpace', () => {
  test('a bare Space is the dictation key', () => {
    expect(isDictationSpace(keyEvent({ key: ' ' }))).toBe(true)
  })

  test('Space with a modifier is a shortcut, not dictation', () => {
    expect(isDictationSpace(keyEvent({ key: ' ', ctrlKey: true }))).toBe(false)
    expect(isDictationSpace(keyEvent({ key: ' ', shiftKey: true }))).toBe(false)
  })

  test('other keys are not the dictation key', () => {
    expect(isDictationSpace(keyEvent({ key: 'a' }))).toBe(false)
  })
})

describe('floatToPcm16', () => {
  test('maps the full float range onto 16-bit samples', () => {
    const pcm = new Int16Array(floatToPcm16(new Float32Array([0, 1, -1])))

    expect(Array.from(pcm)).toEqual([0, 32767, -32768])
  })

  test('clamps samples outside the float range', () => {
    const pcm = new Int16Array(floatToPcm16(new Float32Array([2, -3])))

    expect(Array.from(pcm)).toEqual([32767, -32768])
  })

  test('returns two bytes per sample', () => {
    expect(floatToPcm16(new Float32Array(1024)).byteLength).toBe(2048)
  })
})

describe('describeVoiceError', () => {
  test('strips the IPC wrapper Electron adds to a failed call', () => {
    const error = new Error(
      "Error invoking remote method 'voice:start': VoiceSignInError: Voice dictation needs a claude.ai sign-in."
    )

    expect(describeVoiceError(error)).toBe('Voice dictation needs a claude.ai sign-in.')
  })

  test('keeps a plain message as it is', () => {
    expect(describeVoiceError(new Error('Microphone access denied.'))).toBe(
      'Microphone access denied.'
    )
  })

  test('reads a thrown string as text', () => {
    expect(describeVoiceError('boom')).toBe('boom')
  })

  test('falls back to a generic message for anything else', () => {
    expect(describeVoiceError({ code: 42 })).toBe('Voice dictation failed.')
  })
})

describe('spliceDictation', () => {
  test('writes dictated text at the anchor, after what is before it', () => {
    expect(spliceDictation('use the  rest', 8, 0, 'new helper')).toBe('use the new helper rest')
  })

  test('replaces the text a previous update wrote, so live text grows in place', () => {
    const first = spliceDictation('ask: ', 5, 0, 'use the')
    const second = spliceDictation(first, 5, 'use the'.length, 'use the new helper')
    expect(second).toBe('ask: use the new helper')
  })

  test('an empty update removes the dictated text', () => {
    expect(spliceDictation('ask: use the new', 5, 'use the new'.length, '')).toBe('ask: ')
  })
})
