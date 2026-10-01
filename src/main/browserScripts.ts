// Scripts the browser preview runs inside the page.
//
// Kept as source text rather than functions: they run in another process, and
// a bundled function's text can refer to helpers the bundler hoisted out of it.
// Each is a function expression taking one JSON argument; `scriptCall` applies it.

/** The call of a page script with its argument. */
export function scriptCall(script: string, argument: unknown): string {
  return `(${script})(${JSON.stringify(argument)})`
}

// A selector that finds exactly this element: its test id or id when those
// are unique, else its path from the nearest such ancestor by position.
const SELECTOR_OF = `
function selectorOf(element) {
  const unique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1 } catch { return false }
  }
  const own = (node) => {
    const testId = node.getAttribute('data-testid')
    if (testId && unique('[data-testid="' + CSS.escape(testId) + '"]')) return '[data-testid="' + CSS.escape(testId) + '"]'
    if (node.id && unique('#' + CSS.escape(node.id))) return '#' + CSS.escape(node.id)
    return null
  }
  const parts = []
  let node = element
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    const anchor = own(node)
    if (anchor) { parts.unshift(anchor); break }
    let part = node.tagName.toLowerCase()
    const parent = node.parentElement
    if (parent) {
      const same = [...parent.children].filter((child) => child.tagName === node.tagName)
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
    }
    parts.unshift(part)
    if (unique(parts.join(' > '))) break
    node = parent
  }
  return parts.join(' > ')
}
`

// What an element is called: what a screen reader would read, roughly.
const NAME_OF = `
function nameOf(element) {
  const text = element.getAttribute('aria-label') || element.innerText || element.value ||
    element.getAttribute('placeholder') || element.getAttribute('title') || element.getAttribute('alt') || ''
  const flat = String(text).replace(/\\s+/g, ' ').trim()
  return flat.length > 80 ? flat.slice(0, 79) + '…' : flat
}
`

/**
 * Lets the user point at an element: outlines what is under the pointer and
 * resolves with the one clicked, or null on Escape. The click itself does not
 * reach the page.
 */
export const PICK_SCRIPT = `(() => new Promise((resolve) => {
  ${SELECTOR_OF}
  ${NAME_OF}
  if (window.__grovePickCancel) window.__grovePickCancel()
  const mark = document.createElement('div')
  Object.assign(mark.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', display: 'none',
    border: '2px solid #f5a524', borderRadius: '3px', background: 'rgba(245, 165, 36, 0.15)'
  })
  document.documentElement.appendChild(mark)
  let current = null
  const onMove = (event) => {
    const element = document.elementFromPoint(event.clientX, event.clientY)
    if (!element || element === mark) return
    current = element
    const rect = element.getBoundingClientRect()
    Object.assign(mark.style, { display: 'block', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' })
  }
  const swallow = (event) => { event.preventDefault(); event.stopPropagation() }
  const finish = (value) => {
    removeEventListener('mousemove', onMove, true)
    removeEventListener('click', onClick, true)
    removeEventListener('mousedown', swallow, true)
    removeEventListener('mouseup', swallow, true)
    removeEventListener('keydown', onKey, true)
    mark.remove()
    window.__grovePickCancel = null
    resolve(value)
  }
  const onClick = (event) => {
    swallow(event)
    if (!current) return
    const html = current.outerHTML
    finish({ selector: selectorOf(current), tag: current.tagName.toLowerCase(), name: nameOf(current), html: html.length > 600 ? html.slice(0, 600) + '…' : html, url: location.href })
  }
  const onKey = (event) => { if (event.key === 'Escape') { swallow(event); finish(null) } }
  addEventListener('mousemove', onMove, true)
  addEventListener('click', onClick, true)
  addEventListener('mousedown', swallow, true)
  addEventListener('mouseup', swallow, true)
  addEventListener('keydown', onKey, true)
  window.__grovePickCancel = () => finish(null)
}))`

/** Ends a pick in progress, if there is one. */
export const CANCEL_PICK_SCRIPT = `(() => { if (window.__grovePickCancel) window.__grovePickCancel() })`
