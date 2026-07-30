import { mount } from 'svelte'

import './assets/main.css'

import App from './App.svelte'
import { store } from './lib/store.svelte'
import { review } from './lib/review.svelte'
import { keymap } from './lib/keymap.svelte'
import { layout } from './lib/layout.svelte'
import { inlineEdit } from './lib/inlineEdit.svelte'
import * as nvimRegistry from './lib/nvim/registry'

const app = mount(App, {
  target: document.getElementById('app')!
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
    nvimRegistry
  }
}

export default app
