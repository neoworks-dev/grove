import { mount } from 'svelte'

import './assets/main.css'

import App from './App.svelte'
import { store, syncWatched } from './lib/store.svelte'
import { review } from './lib/review.svelte'
import { keymap } from './lib/keymap.svelte'
import { layout } from './lib/layout.svelte'
import { inlineEdit } from './lib/inlineEdit.svelte'
import { intro } from './lib/intro.svelte'
import { nibSessions } from './lib/nib/sessions.svelte'
import * as nibTranscript from './lib/nib/transcript'
import * as nvimRegistry from './lib/nvim/registry'

const app = mount(App, {
  target: document.getElementById('app')!
})

// An agent starting or finishing in an unselected worktree changes what has to
// be watched for file changes, and that is learned from polling nib's session
// list rather than from an event — so follow it reactively.
$effect.root(() => {
  $effect(() => {
    void store.activeAgentWorktrees.length
    syncWatched()
  })

  // The onboarding agent reports its phase as a surface on its own stream, so
  // the stepper follows the transcript rather than an event.
  $effect(() => {
    intro.syncPhase()
  })
})

// Publish the stores for the debug harness (scripts/grove-debug.ts), which
// reads them over the app API to diagnose UI state. Only under GROVE_DEBUG, so
// a normal build exposes nothing on window.
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

export default app
