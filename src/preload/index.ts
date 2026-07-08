import { contextBridge, ipcRenderer } from 'electron'
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
    active: () => ipcRenderer.invoke('agents:active')
  },
  fs: {
    watch: (worktreeIds: string[]) => ipcRenderer.invoke('fs:watch', worktreeIds)
  },
  files: {
    listDir: (worktreeId: string, relPath: string) =>
      ipcRenderer.invoke('files:listDir', worktreeId, relPath),
    listAll: (worktreeId: string) => ipcRenderer.invoke('files:listAll', worktreeId),
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
      ipcRenderer.invoke('files:delete', worktreeId, relPath)
  },
  search: {
    ripgrep: (worktreeId: string, query: string, reqId: string) =>
      ipcRenderer.invoke('search:ripgrep', worktreeId, query, reqId),
    cancel: () => ipcRenderer.invoke('search:cancel')
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
      ipcRenderer.invoke('lsp:hover', worktreeId, language, uri, position)
  },
  state: {
    getRepo: () => ipcRenderer.invoke('state:getRepo'),
    update: (patch: Record<string, unknown>) => ipcRenderer.invoke('state:update', patch)
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
