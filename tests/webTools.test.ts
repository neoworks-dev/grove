// Grove mode's web tools: reading search result pages, and turning a fetched
// page into Markdown the agent can read whole or grep. All offline, on markup
// shaped like what the services and sites return.

import { describe, expect, test } from 'bun:test'
import {
  matchingSections,
  outlineOf,
  pageOf,
  parseBraveResults,
  parseExaResults
} from '../src/main/agents/tools/webTools'

describe('search results', () => {
  test("reads Exa's title, URL and highlight blocks", () => {
    const text = [
      'Title: Variables | Developer Docs',
      'URL: https://developers.figma.com/docs/rest-api/variables/',
      'Published: N/A',
      'Author: N/A',
      'Highlights:',
      'The Variables REST API includes endpoints.',
      '...',
      'Publish them before use.',
      '',
      '---',
      '',
      'Title: Endpoints',
      'URL: https://developers.figma.com/docs/rest-api/variables-endpoints/',
      'Highlights:',
      ''
    ].join('\n')

    expect(parseExaResults(text)).toEqual([
      {
        title: 'Variables | Developer Docs',
        url: 'https://developers.figma.com/docs/rest-api/variables/',
        snippet: 'The Variables REST API includes endpoints. Publish them before use.'
      },
      {
        title: 'Endpoints',
        url: 'https://developers.figma.com/docs/rest-api/variables-endpoints/',
        snippet: ''
      }
    ])
  })

  test('skips an Exa block without a URL, such as its rate-limit notice', () => {
    expect(parseExaResults("You've hit Exa's free MCP rate limit.")).toEqual([])
  })

  test("reads Brave's web results and skips everything else on the page", () => {
    const html = `
      <div class="snippet" data-type="news"><a href="https://news.example/x"><div class="title">News</div></a></div>
      <div class="snippet svelte-jmfu5f" data-pos="0" data-type="web">
        <a href="https://tokio.rs/tokio/tutorial/select" class="l1">
          <cite class="snippet-url">tokio.rs › tokio › tutorial</cite>
          <div class="title search-snippet-title" title="Select | Tokio">Select | Tokio</div>
        </a>
        <div class="generic-snippet"><div class="content"><!---->So far, when we wanted to add <strong>concurrency</strong>.</div></div>
      </div>
      <div class="snippet" data-type="web"><a href="/search?q=more"><div class="title">More</div></a></div>`

    expect(parseBraveResults(html)).toEqual([
      {
        title: 'Select | Tokio',
        url: 'https://tokio.rs/tokio/tutorial/select',
        snippet: 'So far, when we wanted to add concurrency.'
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
    const page = pageOf(
      docsPage,
      'text/html; charset=utf-8',
      'https://svelte.dev/docs/svelte/$state'
    )

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
