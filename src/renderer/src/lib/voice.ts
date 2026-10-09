// Pure helpers for push-to-talk dictation. The dictation key is a bare Space: a
// short press types a space as usual, and a press held past SPACE_HOLD_MS starts
// dictation (see SpaceHold). Kept free of DOM and IPC so they can be tested.

/** Samples per second the speech-to-text endpoint expects. */
export const VOICE_SAMPLE_RATE = 16000

/** True for a Space pressed with no modifiers, the only key that dictates. */
export function isDictationSpace(event: KeyboardEvent): boolean {
  return event.key === ' ' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
}

/** Converts float samples in [-1, 1] to 16-bit little-endian PCM, clamping anything outside that range. */
export function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index++) {
    const clamped = Math.max(-1, Math.min(1, samples[index]))
    if (clamped < 0) {
      pcm[index] = clamped * 0x8000
    } else {
      pcm[index] = clamped * 0x7fff
    }
  }
  return pcm.buffer
}

/** Strips the IPC wrapper Electron adds to a failed invoke, leaving the message the user should read. */
export function describeVoiceError(error: unknown): string {
  if (error instanceof Error) return stripIpcWrapper(error.message)
  if (typeof error === 'string') return stripIpcWrapper(error)
  return 'Voice dictation failed.'
}

/** Removes the `Error invoking remote method` prefix Electron adds to errors thrown in main. */
function stripIpcWrapper(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*': (\w+Error: )?/, '')
}
