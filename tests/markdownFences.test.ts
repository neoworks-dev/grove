// Code fences must render inside a `.code-fence` wrapper: the floating scrollbar
// is mounted into that wrapper, and nothing may be moved in the DOM afterwards
// because {@html} owns those nodes.

import { describe, expect, mock, test } from 'bun:test'

// DOMPurify needs a browser DOM; the assertions here are about what marked
// emits, so sanitizing is a pass-through in this test.
mock.module('dompurify', () => ({
  default: { sanitize: (html: string) => html }
}))

const { renderMarkdown } = await import('../src/renderer/src/lib/markdown')

describe('renderMarkdown code fences', () => {
  test('wraps a fence in a positioned wrapper', () => {
    const html = renderMarkdown('```ts\nconst a = 1\n```')
    expect(html).toContain('<div class="code-fence"><pre><code class="language-ts">')
  })

  test('keeps a fence without a language', () => {
    const html = renderMarkdown('```\nplain\n```')
    expect(html).toContain('<div class="code-fence"><pre><code>plain')
  })

  test('escapes markup inside a fence', () => {
    const html = renderMarkdown('```html\n<img src=x onerror=alert(1)>\n```')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
  })

  test('leaves inline code out of the wrapper', () => {
    const html = renderMarkdown('use `bun test` here')
    expect(html).toContain('<code>bun test</code>')
    expect(html).not.toContain('code-fence')
  })
})
