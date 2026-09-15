// Entry point for the detached terminal daemon.
//
// Built as its own chunk beside the main process bundle and started with
// Electron's node runtime (`ELECTRON_RUN_AS_NODE=1`), so the native node-pty
// build grove already ships is the one it loads.

import { startTerminalDaemon } from './terminals/daemon'

startTerminalDaemon(process.argv[2])
