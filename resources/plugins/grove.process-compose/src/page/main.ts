// The Process Compose pane page: a Svelte app on @neoworks-dev/ui, talking to
// the plugin's worker (src/extension.ts) through the pane connection.

import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'

mount(App, { target: document.getElementById('app') as HTMLElement })
