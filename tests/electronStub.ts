// One electron stub for the whole suite.
//
// bun's module mocks are global and last-registration-wins across files, so a
// partial stub in one test file breaks another that needs a different member.
// Every test that has to load an electron-importing module registers this one
// instead, and overrides only the parts it cares about.

export interface AppStub {
  isPackaged: boolean
  getAppPath: () => string
  getPath: (name?: string) => string
}

/** Mutable app paths; tests point these at their own sandbox. */
export const appStub: AppStub = {
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getPath: () => process.cwd()
}

/** Channels registered through the stubbed ipcMain, by channel name. */
export const ipcHandlers = new Map<string, unknown>()

/** The stub module. Pass it to `mock.module('electron', () => electronStub)`. */
export const electronStub = {
  app: {
    get isPackaged() {
      return appStub.isPackaged
    },
    getAppPath: (...args: []) => appStub.getAppPath(...args),
    getPath: (name?: string) => appStub.getPath(name)
  },
  ipcMain: {
    handle: (channel: string, handler: unknown) => ipcHandlers.set(channel, handler),
    removeHandler: (channel: string) => ipcHandlers.delete(channel)
  },
  protocol: {
    handle: () => {},
    unhandle: () => {},
    registerSchemesAsPrivileged: () => {}
  },
  shell: { openExternal: () => {}, openPath: () => {} },
  dialog: { showOpenDialog: () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: { getAllWindows: () => [] }
}
