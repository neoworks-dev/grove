import { mount } from 'svelte'

import './assets/main.css'

import App from './App.svelte'
import { startAppEffects } from './lib/appEffects.svelte'
import { store } from './lib/store.svelte'
import { review } from './lib/review.svelte'
import { keymap } from './lib/keymap.svelte'
import { layout } from './lib/layout.svelte'
import { inlineEdit } from './lib/inlineEdit.svelte'
import { nibSessions } from './lib/nib/sessions.svelte'
import * as nibTranscript from './lib/nib/transcript'
import * as nvimRegistry from './lib/nvim/registry'

const app = mount(App, {
  target: document.getElementById('app')!
})

// Publish the stores for the debug harness (scripts/grove-debug.ts), which
// reads them over the app API to diagnose UI state. Only under GROVE_DEBUG, so
// a normal build exposes nothing on window. Published before the app-level
// effects run, so a failure in one of them still leaves the app diagnosable.
if (window.workbench?.debug) {
  ;(window as unknown as Record<string, unknown>).__grove_debug = {
    store,
    review,
    keymap,
    layout,
    inlineEdit,
    nvimRegistry,
    nibSessions,
    // The transcript fold, so the harness can read pending approvals out of a
    // live session the same way the pane does.
    nibTranscript
  }
}

try {
  startAppEffects()
} catch (error) {
  // These effects are app-wide bookkeeping, not the app: keep running, and leave
  // the reason somewhere the harness can read it.
  const message = error instanceof Error ? error.stack || error.message : String(error)
  console.error('app effects failed to start', error)
  ;(window as unknown as Record<string, unknown>).__grove_boot_error = message
}

export default app
