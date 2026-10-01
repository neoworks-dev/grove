// Grove mode's web tools: reading search result pages, and turning a fetched
// page into Markdown the agent can read whole or grep. All offline, on markup
// shaped like what the services and sites return.

import { describe, expect, test } from 'bun:test'
import {
  matchingSections,
  outlineOf,
  pageOf,
  parseBingResults,
  parseDuckDuckGoResults
} from '../src/main/agents/tools/webTools'

describe('search results', () => {
  test('reads DuckDuckGo results, direct and redirected, and skips its ads', () => {
    const html = `
      <div class="result results_links web-result result--ad">
        <h2><a class="result__a" href="https://ads.example/buy">Buy now</a></h2>
      </div>
      <div class="result results_links web-result">
        <h2><a class="result__a" href="https://svelte.dev/blog/runes">Introducing <b>runes</b></a></h2>
        <a class="result__snippet">What are <b>runes</b>?</a>
      </div>
      <div class="result results_links web-result">
        <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=x">Docs</a></h2>
      </div>`

    expect(parseDuckDuckGoResults(html)).toEqual([
      { title: 'Introducing runes', url: 'https://svelte.dev/blog/runes', snippet: 'What are runes?' },
      { title: 'Docs', url: 'https://example.com/docs', snippet: '' }
    ])
  })

  test("unwraps Bing's redirect links", () => {
    const target = Buffer.from('https://de.wikipedia.org/wiki/Svelte').toString('base64url')
    const html = `
      <li class="b_algo">
        <h2><a href="https://www.bing.com/ck/a?!&amp;p=1&amp;u=a1${target}&amp;ntb=1">Svelte – Wikipedia</a></h2>
        <div class="b_caption"><p>Svelte ist eine freie Bibliothek.</p></div>
      </li>`

    expect(parseBingResults(html)).toEqual([
      {
        title: 'Svelte – Wikipedia',
        url: 'https://de.wikipedia.org/wiki/Svelte',
        snippet: 'Svelte ist eine freie Bibliothek.'
      }
    ])
  })
})

describe('a fetched page', () => {
  const docsPage = `<html><head><title>$state • Docs</title></head><body>
    <nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
    <main>
      <h2 id="deep">Deep state <a href="#deep">#</a></h2>
      <p>See the <a href="/playground">playground</a> and <a href="#classes">classes</a>.</p>
      <pre><code>let count = <span class="twoslash-hover">$state<span class="twoslash-popover">function $state&lt;T&gt;(initial: T): T</span></span>(0);</code></pre>
      <span aria-hidden="true">decoration</span>
    </main>
    <footer>© someone</footer>
  </body></html>`

  test('keeps the content as Markdown, without the furniture, tooltips or heading anchors', () => {
    const page = pageOf(docsPage, 'text/html; charset=utf-8', 'https://svelte.dev/docs/svelte/$state')

    expect(page?.markdown).toContain('## Deep state\n')
    expect(page?.markdown).toContain('let count = $state(0);')
    expect(page?.markdown).not.toContain('twoslash')
    expect(page?.markdown).not.toContain('function $state<T>')
    expect(page?.markdown).not.toContain('decoration')
    expect(page?.markdown).not.toContain('Home')
    expect(page?.markdown).not.toContain('#deep')
  })

  test('makes relative links absolute and keeps in-page link text', () => {
    const page = pageOf(docsPage, 'text/html', 'https://svelte.dev/docs/svelte/$state')

    expect(page?.markdown).toContain('[playground](https://svelte.dev/playground)')
    expect(page?.markdown).toContain('and classes.')
  })

  test('passes plain text through, and turns down what is not text', () => {
    expect(pageOf('{"a":1}', 'application/json', 'https://x.dev/a.json')?.markdown).toBe('{"a":1}')
    expect(pageOf('%PDF', 'application/pdf', 'https://x.dev/a.pdf')).toBeNull()
  })
})

describe('reading a saved page', () => {
  const lines = [
    '# Child process',
    'Intro.',
    '## spawn',
    'Spawns a process.',
    '```',
    '# not a heading',
    '```',
    '### options.detached',
    'A detached child leads its own process group.',
    '## exec',
    'Runs a command in a shell; not detached.'
  ]

  test('outlines the headings outside code, with their lines', () => {
    expect(outlineOf(lines)).toEqual([
      { line: 1, level: 1, text: 'Child process' },
      { line: 3, level: 2, text: 'spawn' },
      { line: 8, level: 3, text: 'options.detached' },
      { line: 10, level: 2, text: 'exec' }
    ])
  })

  test('puts the section whose heading names what was asked for first', () => {
    const found = matchingSections(lines, 'detached')

    expect(found.indexOf('[lines 8-9]')).toBeLessThan(found.indexOf('[lines 10-11]'))
    expect(found).not.toContain('[lines 3-7]')
  })

  test('says so when nothing matches', () => {
    expect(matchingSections(lines, 'websocket')).toBe('Nothing matches "websocket".')
  })
})
