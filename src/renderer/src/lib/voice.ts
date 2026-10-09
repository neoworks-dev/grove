// Pure helpers for push-to-talk dictation. The push-to-talk key is Ctrl+Space
// rather than a bare Space: a held Space types into the prompt and would need
// key-repeat detection to tell a hold from a tap, while Ctrl+Space types nothing
// and starts on the first keydown. Kept free of DOM and IPC so they can be tested.

/** Samples per second the speech-to-text endpoint expects. */
export const VOICE_SAMPLE_RATE = 16000

/** True on the keydown that starts a dictation: the push-to-talk chord, not an auto-repeat. */
export function isPushToTalkPress(event: KeyboardEvent): boolean {
  return event.key === ' ' && event.ctrlKey && !event.altKey && !event.metaKey && !event.repeat
}

/** True on the keyup that ends a dictation: releasing either the Space or the Ctrl of the chord. */
export function isPushToTalkRelease(event: KeyboardEvent): boolean {
  return event.key === ' ' || event.key === 'Control'
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

/** Turns a failed IPC call into the message the user should read, without Electron's wrapper. */
export function describeVoiceError(error: unknown): string {
  if (error instanceof Error) return stripIpcWrapper(error.message)
  if (typeof error === 'string') return stripIpcWrapper(error)
  return 'Voice dictation failed.'
}

/** Removes the `Error invoking remote method` prefix Electron adds to errors thrown in main. */
function stripIpcWrapper(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*': (\w+Error: )?/, '')
}
