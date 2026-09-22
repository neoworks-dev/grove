// Links in rendered markdown are untrusted — a GitHub comment or an agent's
// output — and a plain anchor click navigates the app's own top-level frame.
// These decide which navigations stay in the window and which leave it.

/** Schemes a link may hand to the OS; anything else (file:, custom handlers) is dropped. */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/** Parses a URL, or returns null when it is not one. */
function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/**
 * Whether a navigation from `currentUrl` to `targetUrl` stays on the app's own
 * document — same origin, and for `file:` the same file. A dev-server reload or
 * a hash change passes; a link out to anywhere else does not.
 */
export function isAppNavigation(currentUrl: string, targetUrl: string): boolean {
  const current = parseUrl(currentUrl)
  const target = parseUrl(targetUrl)
  if (!current || !target) {
    return false
  }
  if (current.protocol === 'file:') {
    return target.protocol === 'file:' && target.pathname === current.pathname
  }
  return target.origin === current.origin
}

/** Whether a URL may be opened in the user's browser or mail client. */
export function isExternallyOpenable(url: string): boolean {
  const parsed = parseUrl(url)
  if (!parsed) {
    return false
  }
  return EXTERNAL_SCHEMES.has(parsed.protocol)
}
