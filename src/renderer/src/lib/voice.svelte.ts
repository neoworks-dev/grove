// Push-to-talk dictation for the composer. Holding the key opens the microphone and
// streams its audio to main, which relays it to the speech-to-text endpoint;
// releasing the key closes the stream and returns the transcript for the composer
// to insert. Audio captured while the connection is still opening is held back and
// sent once it is up, so the first words are not lost.

import { dialogs } from './dialogs.svelte'
import { describeVoiceError, floatToPcm16, VOICE_SAMPLE_RATE } from './voice'

export type VoiceState = 'idle' | 'starting' | 'recording' | 'finishing'

/** Samples per capture block: 1024 at 16 kHz is 64 ms, short enough to stream without lag. */
const CAPTURE_BLOCK_SAMPLES = 1024

interface Microphone {
  stop: () => void
}

/** Opens the default microphone and calls onChunk with each block as 16-bit PCM until stopped. */
async function openMicrophone(onChunk: (pcm: ArrayBuffer) => void): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  })
  const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE })
  if (context.sampleRate !== VOICE_SAMPLE_RATE) {
    stream.getTracks().forEach((track) => track.stop())
    void context.close()
    throw new Error(`The audio device runs at ${context.sampleRate} Hz, not ${VOICE_SAMPLE_RATE} Hz.`)
  }
  const source = context.createMediaStreamSource(stream)
  // A script processor rather than an audio worklet: a worklet needs its own script
  // file, which the renderer's script-src policy would have to allow for file pages.
  const processor = context.createScriptProcessor(CAPTURE_BLOCK_SAMPLES, 1, 1)
  processor.onaudioprocess = (event): void => {
    onChunk(floatToPcm16(event.inputBuffer.getChannelData(0)))
  }
  // Routed through a silent gain so the processor runs without playing the microphone back.
  const silence = context.createGain()
  silence.gain.value = 0
  source.connect(processor)
  processor.connect(silence)
  silence.connect(context.destination)
  return {
    stop: (): void => {
      processor.onaudioprocess = null
      processor.disconnect()
      source.disconnect()
      silence.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      void context.close()
    }
  }
}

/** The dictation session: one at a time, driven by the composer's push-to-talk key. */
class VoiceDictation {
  state = $state<VoiceState>('idle')

  #microphone: Microphone | null = null
  #queue: ArrayBuffer[] = []
  #streaming = false
  #startPromise: Promise<void> = Promise.resolve()
  #unsubscribers: Array<() => void> = []
  #showTranscript: ((text: string) => void) | null = null

  /** Starts a dictation. onTranscript receives the whole text so far as it changes. Failures are reported, not thrown. */
  start(options: { onTranscript: (text: string) => void }): Promise<void> {
    if (this.state !== 'idle') return Promise.resolve()
    this.state = 'starting'
    this.#showTranscript = options.onTranscript
    this.#startPromise = this.beginDictation()
    return this.#startPromise
  }

  /** Abandons a dictation without inserting its transcript, for when focus leaves the composer. */
  cancel(): void {
    if (this.state === 'idle') return
    void this.stop()
  }

  /** Ends the dictation and resolves with the transcript, which is empty if nothing was heard or it failed. */
  async stop(): Promise<string> {
    await this.#startPromise
    if (this.state !== 'recording') return ''
    this.state = 'finishing'
    this.#teardownMicrophone()
    try {
      const transcript = await window.workbench.voice.stop()
      this.state = 'idle'
      return transcript
    } catch (error) {
      this.state = 'idle'
      this.#report(error)
      return ''
    }
  }

  /** Opens the microphone and the stream, holding audio until the stream accepts it. */
  private async beginDictation(): Promise<void> {
    this.#queue = []
    this.#streaming = false
    this.#unsubscribers = [
      window.workbench.on('event:voice-error', (payload) => this.#onStreamError(payload)),
      window.workbench.on('event:voice-transcript', (payload) => this.#receiveTranscript(payload))
    ]
    try {
      this.#microphone = await openMicrophone((pcm) => this.#onMicrophoneChunk(pcm))
      await window.workbench.voice.start()
    } catch (error) {
      this.#teardownMicrophone()
      this.state = 'idle'
      this.#report(error)
      return
    }
    this.#streaming = true
    for (const pcm of this.#queue) this.#sendAudio(pcm)
    this.#queue = []
    this.state = 'recording'
  }

  #onMicrophoneChunk(pcm: ArrayBuffer): void {
    if (this.#streaming) this.#sendAudio(pcm)
    else this.#queue.push(pcm)
  }

  #sendAudio(pcm: ArrayBuffer): void {
    window.workbench.voice.audio(pcm).catch((error: unknown) => this.#abort(error))
  }

  /** Hands the whole transcript so far to the composer, which shows it in the prompt as it grows. */
  #receiveTranscript(payload: unknown): void {
    const { text } = payload as { text: string }
    this.#showTranscript?.(text)
  }

  /** The server or connection failed mid-dictation: stop capturing and say why. */
  #onStreamError(payload: unknown): void {
    const { message } = payload as { message: string }
    this.#abort(new Error(message))
  }

  /** Stops a dictation that has failed. Whatever was said so far is lost. */
  #abort(error: unknown): void {
    if (this.state === 'idle') return
    this.#teardownMicrophone()
    this.state = 'idle'
    this.#report(error)
  }

  #teardownMicrophone(): void {
    this.#microphone?.stop()
    this.#microphone = null
    for (const unsubscribe of this.#unsubscribers) unsubscribe()
    this.#unsubscribers = []
  }

  #report(error: unknown): void {
    dialogs.notify({ level: 'error', message: describeVoiceError(error) })
  }
}

export const voiceDictation = new VoiceDictation()
