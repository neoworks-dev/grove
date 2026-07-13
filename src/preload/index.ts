import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Typed, namespaced bridge exposed as window.workbench. Every method is a thin
// wrapper over ipcRenderer.invoke; events use ipcRenderer.on with unsubscribe.

const workbench = {
  repo: {
    pick: () => ipcRenderer.invoke('repo:pick'),
    open: (repoPath: string) => ipcRenderer.invoke('repo:open', repoPath),
    last: () => ipcRenderer.invoke('repo:last')
  },
  worktrees: {
    list: () => ipcRenderer.invoke('worktrees:list'),
    create: (options: { name: string; baseBranch: string; newBranch?: string }) =>
      ipcRenderer.invoke('worktrees:create', options),
    remove: (worktreeId: string, force: boolean) =>
      ipcRenderer.invoke('worktrees:remove', worktreeId, force)
  },
  git: {
    branches: () => ipcRenderer.invoke('git:branches'),
    changedFiles: (worktreeId: string) => ipcRenderer.invoke('git:changedFiles', worktreeId),
    diffSides: (worktreeId: string, file: unknown) =>
      ipcRenderer.invoke('git:diffSides', worktreeId, file)
  },
  config: {
    load: () => ipcRenderer.invoke('config:load'),
    exists: () => ipcRenderer.invoke('config:exists'),
    writeSample: () => ipcRenderer.invoke('config:writeSample')
  },
  services: {
    list: (worktreeId: string) => ipcRenderer.invoke('services:list', worktreeId),
    start: (worktreeId: string, name: string) =>
      ipcRenderer.invoke('services:start', worktreeId, name),
    startAll: (worktreeId: string) => ipcRenderer.invoke('services:startAll', worktreeId),
    stop: (worktreeId: string, name: string) =>
      ipcRenderer.invoke('services:stop', worktreeId, name),
    stopAll: (worktreeId: string) => ipcRenderer.invoke('services:stopAll', worktreeId),
    restart: (worktreeId: string, name: string) =>
      ipcRenderer.invoke('services:restart', worktreeId, name)
  },
  agents: {
    list: (worktreeId: string) => ipcRenderer.invoke('agents:list', worktreeId),
    configs: () => ipcRenderer.invoke('agents:configs'),
    start: (worktreeId: string, name: string, options: unknown) =>
      ipcRenderer.invoke('agents:start', worktreeId, name, options),
    stop: (worktreeId: string, name: string) => ipcRenderer.invoke('agents:stop', worktreeId, name),
    compact: (worktreeId: string, name: string, instructions?: string) =>
      ipcRenderer.invoke('agents:compact', worktreeId, name, instructions),
    reset: (worktreeId: string, name: string) =>
      ipcRenderer.invoke('agents:reset', worktreeId, name),
    transcript: (worktreeId: string, name: string) =>
      ipcRenderer.invoke('agents:transcript', worktreeId, name),
    chats: (worktreeId: string, name: string) =>
      ipcRenderer.invoke('agents:chats', worktreeId, name),
    renameChat: (worktreeId: string, name: string, chatId: string, chatName: string) =>
      ipcRenderer.invoke('agents:renameChat', worktreeId, name, chatId, chatName),
    activateChat: (worktreeId: string, name: string, chatId: string) =>
      ipcRenderer.invoke('agents:activateChat', worktreeId, name, chatId),
    respondPermission: (id: string, decision: unknown) =>
      ipcRenderer.invoke('agents:respondPermission', id, decision),
    respondDialog: (id: string, decision: unknown) =>
      ipcRenderer.invoke('agents:respondDialog', id, decision),
    active: () => ipcRenderer.invoke('agents:active'),
    send: (worktreeId: string, name: string, text: string) =>
      ipcRenderer.invoke('agents:send', worktreeId, name, text),
    queue: (worktreeId: string, name: string) =>
      ipcRenderer.invoke('agents:queue', worktreeId, name),
    cancelQueued: (worktreeId: string, name: string, id: string) =>
      ipcRenderer.invoke('agents:cancelQueued', worktreeId, name, id),
    commands: (worktreeId: string, name: string) =>
      ipcRenderer.invoke('agents:commands', worktreeId, name)
  },
  fs: {
    watch: (worktreeIds: string[]) => ipcRenderer.invoke('fs:watch', worktreeIds)
  },
  files: {
    listDir: (worktreeId: string, relPath: string) =>
      ipcRenderer.invoke('files:listDir', worktreeId, relPath),
    listAll: (worktreeId: string) => ipcRenderer.invoke('files:listAll', worktreeId),
    listPath: (worktreeId: string, rawPath: string) =>
      ipcRenderer.invoke('files:listPath', worktreeId, rawPath),
    read: (worktreeId: string, absPath: string) =>
      ipcRenderer.invoke('files:read', worktreeId, absPath),
    write: (worktreeId: string, absPath: string, content: string) =>
      ipcRenderer.invoke('files:write', worktreeId, absPath, content),
    create: (worktreeId: string, relPath: string) =>
      ipcRenderer.invoke('files:create', worktreeId, relPath),
    createDir: (worktreeId: string, relPath: string) =>
      ipcRenderer.invoke('files:createDir', worktreeId, relPath),
    rename: (worktreeId: string, fromRel: string, toRel: string) =>
      ipcRenderer.invoke('files:rename', worktreeId, fromRel, toRel),
    delete: (worktreeId: string, relPath: string) =>
      ipcRenderer.invoke('files:delete', worktreeId, relPath),
    saveAttachment: (worktreeId: string, data: Uint8Array, ext: string) =>
      ipcRenderer.invoke('files:saveAttachment', worktreeId, data, ext),
    // Absolute OS path of a dropped File (Electron removed File.path).
    pathForFile: (file: File) => webUtils.getPathForFile(file)
  },
  extensions: {
    catalog: () => ipcRenderer.invoke('extensions:catalog'),
    installed: () => ipcRenderer.invoke('extensions:installed'),
    install: (id: string) => ipcRenderer.invoke('extensions:install', id),
    uninstall: (id: string) => ipcRenderer.invoke('extensions:uninstall', id),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('extensions:setEnabled', id, enabled),
    grammar: (id: string) => ipcRenderer.invoke('extensions:grammar', id)
  },
  lsp: {
    ensure: (worktreeId: string, language: string, uri: string, text: string) =>
      ipcRenderer.invoke('lsp:ensure', worktreeId, language, uri, text),
    didChange: (worktreeId: string, language: string, uri: string, version: number, text: string) =>
      ipcRenderer.invoke('lsp:didChange', worktreeId, language, uri, version, text),
    completion: (worktreeId: string, language: string, uri: string, position: unknown) =>
      ipcRenderer.invoke('lsp:completion', worktreeId, language, uri, position),
    hover: (worktreeId: string, language: string, uri: string, position: unknown) =>
      ipcRenderer.invoke('lsp:hover', worktreeId, language, uri, position),
    definition: (worktreeId: string, language: string, uri: string, position: unknown) =>
      ipcRenderer.invoke('lsp:definition', worktreeId, language, uri, position),
    references: (worktreeId: string, language: string, uri: string, position: unknown) =>
      ipcRenderer.invoke('lsp:references', worktreeId, language, uri, position),
    implementation: (worktreeId: string, language: string, uri: string, position: unknown) =>
      ipcRenderer.invoke('lsp:implementation', worktreeId, language, uri, position),
    typeDefinition: (worktreeId: string, language: string, uri: string, position: unknown) =>
      ipcRenderer.invoke('lsp:typeDefinition', worktreeId, language, uri, position),
    declaration: (worktreeId: string, language: string, uri: string, position: unknown) =>
      ipcRenderer.invoke('lsp:declaration', worktreeId, language, uri, position),
    rename: (
      worktreeId: string,
      language: string,
      uri: string,
      position: unknown,
      newName: string
    ) => ipcRenderer.invoke('lsp:rename', worktreeId, language, uri, position, newName),
    formatting: (worktreeId: string, language: string, uri: string, tabSize: number) =>
      ipcRenderer.invoke('lsp:formatting', worktreeId, language, uri, tabSize),
    codeAction: (
      worktreeId: string,
      language: string,
      uri: string,
      range: unknown,
      diagnostics: unknown
    ) => ipcRenderer.invoke('lsp:codeAction', worktreeId, language, uri, range, diagnostics),
    resolveCodeAction: (worktreeId: string, language: string, action: unknown) =>
      ipcRenderer.invoke('lsp:resolveCodeAction', worktreeId, language, action),
    executeCommand: (worktreeId: string, language: string, command: string, args: unknown[]) =>
      ipcRenderer.invoke('lsp:executeCommand', worktreeId, language, command, args),
    inlayHints: (worktreeId: string, language: string, uri: string, range: unknown) =>
      ipcRenderer.invoke('lsp:inlayHints', worktreeId, language, uri, range)
  },
  terminal: {
    create: (worktreeId: string | null, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:create', worktreeId, cols, rows),
    write: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke('terminal:kill', id)
  },
  nvim: {
    spawn: (worktreeId: string | null) => ipcRenderer.invoke('nvim:spawn', worktreeId),
    attach: (id: string, cols: number, rows: number, file?: string) =>
      ipcRenderer.invoke('nvim:attach', id, cols, rows, file),
    input: (id: string, keys: string) => ipcRenderer.invoke('nvim:input', id, keys),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('nvim:resize', id, cols, rows),
    command: (id: string, command: string) => ipcRenderer.invoke('nvim:command', id, command),
    request: (id: string, method: string, args: unknown[]) =>
      ipcRenderer.invoke('nvim:request', id, method, args),
    kill: (id: string) => ipcRenderer.invoke('nvim:kill', id)
  },
  state: {
    getRepo: () => ipcRenderer.invoke('state:getRepo'),
    update: (patch: Record<string, unknown>) => ipcRenderer.invoke('state:update', patch)
  },
  actions: {
    runShell: (worktreeId: string, commandLine: string) =>
      ipcRenderer.invoke('actions:runShell', worktreeId, commandLine)
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    trust: (pluginId: string) => ipcRenderer.invoke('plugins:trust', pluginId),
    setEnabled: (pluginId: string, enabled: boolean) =>
      ipcRenderer.invoke('plugins:setEnabled', pluginId, enabled),
    invoke: (pluginId: string, callId: string, method: string, params: unknown) =>
      ipcRenderer.invoke('plugins:invoke', pluginId, callId, method, params),
    cancel: (pluginId: string, callId: string) =>
      ipcRenderer.invoke('plugins:cancel', pluginId, callId),
    cancelAll: (pluginId: string) => ipcRenderer.invoke('plugins:cancelAll', pluginId),
    respondPermission: (id: string, decision: string) =>
      ipcRenderer.invoke('plugins:respondPermission', id, decision),
    respondToolCall: (id: string, result: unknown, errorMessage?: string) =>
      ipcRenderer.invoke('plugins:respondToolCall', id, result, errorMessage)
  },
  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    set: (key: string, value: unknown, scope: 'user' | 'project') =>
      ipcRenderer.invoke('settings:set', key, value, scope),
    openFile: (scope: 'user' | 'project') => ipcRenderer.invoke('settings:openFile', scope)
  },
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Subscribe to a main->renderer event. Returns an unsubscribe function.
  on: (channel: string, callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => callback(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('workbench', workbench)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.workbench = workbench
}

export type WorkbenchApi = typeof workbench
