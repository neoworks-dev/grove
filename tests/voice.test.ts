// The pure half of push-to-talk dictation: which key events start and end it, how
// float samples become the 16-bit PCM the endpoint reads, and how an IPC failure is
// worded for the user.

import { describe, expect, test } from 'bun:test'
import { describeVoiceError, floatToPcm16, isPushToTalkPress, isPushToTalkRelease } from '../src/renderer/src/lib/voice'

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

describe('isPushToTalkPress', () => {
  test('Ctrl+Space starts a dictation', () => {
    expect(isPushToTalkPress(keyEvent({ key: ' ', ctrlKey: true }))).toBe(true)
  })

  test('a plain Space types a space instead', () => {
    expect(isPushToTalkPress(keyEvent({ key: ' ' }))).toBe(false)
  })

  test('auto-repeat of the chord does not start a second dictation', () => {
    expect(isPushToTalkPress(keyEvent({ key: ' ', ctrlKey: true, repeat: true }))).toBe(false)
  })

  test('other modifiers on top of the chord are not the push-to-talk key', () => {
    expect(isPushToTalkPress(keyEvent({ key: ' ', ctrlKey: true, altKey: true }))).toBe(false)
    expect(isPushToTalkPress(keyEvent({ key: ' ', ctrlKey: true, metaKey: true }))).toBe(false)
  })
})

describe('isPushToTalkRelease', () => {
  test('releasing Space or Control ends the dictation', () => {
    expect(isPushToTalkRelease(keyEvent({ key: ' ' }))).toBe(true)
    expect(isPushToTalkRelease(keyEvent({ key: 'Control' }))).toBe(true)
  })

  test('releasing any other key leaves the dictation running', () => {
    expect(isPushToTalkRelease(keyEvent({ key: 'a' }))).toBe(false)
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
