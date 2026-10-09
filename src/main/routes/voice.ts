// Voice dictation over IPC. One dictation runs at a time: the renderer starts it,
// streams microphone audio into it, and stops it to take the final text. Interim
// and error messages arrive as events, so a dropped connection reaches the composer
// even while the push-to-talk key is still held.

import type { Context } from '@neoworks/extension-system'
import type { IpcMainInvokeEvent } from 'electron'
import { route } from '../kernel/route'
import { readClaudeSignIn } from '../voiceCredentials'
import { openWebSocket, VOICE_STREAM_URL, VoiceStream } from '../voiceStream'

const DICTATION_LANGUAGE = 'en'

export const voiceRoutes = {
  name: 'main/routes/voice',
  inject: ['workbench'],

  apply(ctx: Context): void {
    let active: VoiceStream | null = null

    route(ctx, 'voice:start', async (_e: IpcMainInvokeEvent) => {
      active?.close()
      const { accessToken } = await readClaudeSignIn()
      const stream = new VoiceStream({
        accessToken,
        endpoint: VOICE_STREAM_URL,
        openSocket: openWebSocket,
        language: DICTATION_LANGUAGE,
        onError: (message) => ctx.workbench.send('event:voice-error', { message })
      })
      active = stream
      try {
        await stream.connect()
      } catch (error) {
        active = null
        stream.close()
        throw error
      }
    })

    route(ctx, 'voice:audio', (_e: IpcMainInvokeEvent, chunk: Uint8Array) => {
      active?.sendAudio(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    })

    route(ctx, 'voice:stop', async (_e: IpcMainInvokeEvent) => {
      const stream = active
      active = null
      if (!stream) return ''
      return stream.finish()
    })
  }
}
