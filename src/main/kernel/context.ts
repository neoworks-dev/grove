// The main process's plugin kernel. Same shape as the renderer's: one root
// Context that subsystems provide services on and route plugins register their
// IPC handlers against, so every handler carries the inverse that removes it.

import { Context } from '@neoworks/extension-system'

export const mainContext = new Context()
