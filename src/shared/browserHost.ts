// "Connect Chrome" across IPC: whether the browser extension's native-messaging
// host is installed per browser, and where the extension to load is.

export type ChromiumBrowserId = 'chrome' | 'chromium' | 'edge' | 'brave'

/** Whether the host is installed for one browser, and where. */
export interface BrowserHostStatus {
  id: ChromiumBrowserId
  label: string
  installed: boolean
  /** Whether the browser's config directory exists, i.e. it has been run here. */
  detected: boolean
  manifestPath: string
}

/** Everything the "Connect Chrome" settings show. */
export interface BrowserConnectorStatus {
  /** False on platforms where installing isn't supported (Windows). */
  supported: boolean
  /** Where the unpacked extension is, to load in the browser; copied there on install. */
  extensionPath: string
  extensionCopied: boolean
  extensionId: string
  browsers: BrowserHostStatus[]
}
