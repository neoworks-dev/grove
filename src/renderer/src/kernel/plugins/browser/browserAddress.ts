// The Browser pane's addresses: where a preview starts, what typed text means,
// and how a picked element reads in the composer.

import type { ServiceRuntime } from '../../../../../shared/types'

/**
 * Where a worktree's preview starts: where it was last, else its dev server —
 * a running service's preview address before a stopped one's. Empty when
 * there is neither.
 */
export function startingUrl(remembered: string | undefined, services: readonly ServiceRuntime[]): string {
  if (remembered) return remembered
  const withPreview = services.filter((service) => service.previewUrl)
  const running = withPreview.find((service) => service.status === 'running')
  if (running && running.previewUrl) return running.previewUrl
  if (withPreview.length > 0 && withPreview[0].previewUrl) return withPreview[0].previewUrl
  return ''
}

/**
 * What the address bar's text means as an address: as typed when it has a
 * scheme, else http for a local host and https for anything else.
 */
export function addressOf(typed: string): string {
  const text = typed.trim()
  if (text.length === 0) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^localhost:\d/i.test(text)) return text
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`
  if (/^:\d+/.test(text)) return `http://localhost${text}`
  return `https://${text}`
}

/** How a picked element reads in the composer, for the agent to find it again. */
export function describePickedElement(element: { selector: string; name: string; url: string }): string {
  let text = `the element \`${element.selector}\``
  if (element.name) text += ` (“${element.name}”)`
  return `${text} in the browser preview at ${element.url} `
}
