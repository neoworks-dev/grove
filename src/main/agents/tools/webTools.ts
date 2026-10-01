// Grove mode's way onto the web: `web_search` finds pages, `web_fetch` reads one.
//
// A fetched page is cleaned the way a reader view cleans it and turned into
// Markdown. A short one comes back whole. A long one is written to a file and
// the call returns its outline, so the agent reads or greps the part it needs
// rather than carrying the whole page through every later turn. `find` returns
// the matching sections in the same call, which usually saves that second step.
//
// Search scrapes DuckDuckGo's HTML endpoint, with Bing's results page behind it
// for when DuckDuckGo turns the request away: neither needs a key.

import { createHash } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'
import type { GroveTool, GroveToolContext, GroveToolResult } from '../harness'

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 20_000
const DEFAULT_RESULT_COUNT = 8
const MAX_RESULT_COUNT = 20
/** A page up to this long comes back whole; anything longer goes to a file. */
const INLINE_CHARACTERS = 12_000
/** At most this much of the matching sections comes back for `find`. */
const FIND_CHARACTERS = 12_000
/** Readability keeping less than this share of the page's text means it threw away content. */
const READABLE_SHARE = 0.25

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** One heading of a saved page, and the line it starts on. */
interface OutlineEntry {
  line: number
  level: number
  text: string
}

/** The web tools grove mode serves. */
export function webTools(): GroveTool[] {
  return [webSearchTool(), webFetchTool()]
}

function webSearchTool(): GroveTool {
  return {
    name: 'web_search',
    alwaysLoad: true,
    summary: 'Search the web',
    promptGuidelines: ['Use web_search to find pages, then web_fetch to read the ones that matter'],
    description:
      'Search the web and get back titles, URLs and snippets. Read a result with web_fetch. Use site to search within one domain.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        site: { type: 'string', description: 'Only results from this domain, e.g. "svelte.dev".' },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RESULT_COUNT,
          description: `How many results, ${DEFAULT_RESULT_COUNT} by default.`
        }
      },
      required: ['query'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{query}', input: 'hidden', result: 'markdown' },

    async execute(input) {
      let query = String(input.query)
      if (typeof input.site === 'string' && input.site.trim().length > 0) {
        query = `${query} site:${input.site.trim()}`
      }
      const count = countOf(input.count)
      try {
        const results = await search(query)
        if (results.length === 0) return { content: `No results for "${query}".` }
        return { content: formatResults(results.slice(0, count)) }
      } catch (cause) {
        return { content: `Search failed: ${(cause as Error).message}`, isError: true }
      }
    }
  }
}

function webFetchTool(): GroveTool {
  return {
    name: 'web_fetch',
    alwaysLoad: true,
    summary: 'Read a web page',
    promptGuidelines: [
      'web_fetch saves a long page to a file and returns its outline: read the lines you need or grep the file instead of fetching again'
    ],
    description: `Fetch one URL and get its main content as Markdown, cleaned like a reader view. A page under ${INLINE_CHARACTERS} characters comes back whole. A longer one is saved to a file and the call returns its path and outline with line numbers; read or grep that file for what you need. Pass find to also get the sections that mention those words straight away.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL to read.' },
        find: {
          type: 'string',
          description: 'Words to look for; the sections containing them are returned with the outline.'
        }
      },
      required: ['url'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{url}', input: 'hidden', result: 'markdown' },

    async execute(input, context) {
      const url = parsedUrl(String(input.url))
      if (!url) return { content: `Not an http(s) URL: ${String(input.url)}`, isError: true }
      let find = ''
      if (typeof input.find === 'string') find = input.find.trim()
      try {
        return await fetchPage(url, find, context)
      } catch (cause) {
        return { content: `Could not fetch ${url.href}: ${(cause as Error).message}`, isError: true }
      }
    }
  }
}

// ── Search ──────────────────────────────────────────────────────

/** Results from DuckDuckGo, or from Bing when DuckDuckGo gives none. */
async function search(query: string): Promise<SearchResult[]> {
  let duckDuckGoFailure: Error | null = null
  try {
    const results = await searchDuckDuckGo(query)
    if (results.length > 0) return results
  } catch (cause) {
    duckDuckGoFailure = cause as Error
  }
  try {
    return await searchBing(query)
  } catch (cause) {
    if (duckDuckGoFailure) throw duckDuckGoFailure
    throw cause
  }
}

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const response = await request('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: query }).toString()
  })
  return parseDuckDuckGoResults(await response.text())
}

async function searchBing(query: string): Promise<SearchResult[]> {
  const url = `https://www.bing.com/search?${new URLSearchParams({ q: query, setlang: 'en' })}`
  const response = await request(url, {})
  return parseBingResults(await response.text())
}

/** The organic results on DuckDuckGo's HTML page, ads left out. */
export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const { document } = parseHTML(html)
  const results: SearchResult[] = []
  for (const result of document.querySelectorAll('.result')) {
    if (result.classList.contains('result--ad')) continue
    const link = result.querySelector('a.result__a')
    if (!link) continue
    const url = duckDuckGoTarget(link.getAttribute('href') ?? '')
    if (!url) continue
    results.push({
      title: cleanText(link.textContent),
      url,
      snippet: cleanText(result.querySelector('.result__snippet')?.textContent)
    })
  }
  return results
}

/** The organic results on Bing's results page. */
export function parseBingResults(html: string): SearchResult[] {
  const { document } = parseHTML(html)
  const results: SearchResult[] = []
  for (const result of document.querySelectorAll('li.b_algo')) {
    const link = result.querySelector('h2 a')
    if (!link) continue
    const url = bingTarget(link.getAttribute('href') ?? '')
    if (!url) continue
    results.push({
      title: cleanText(link.textContent),
      url,
      snippet: cleanText(result.querySelector('.b_caption p, p')?.textContent)
    })
  }
  return results
}

/** Where a DuckDuckGo result link goes: direct, or through its `/l/?uddg=` redirect. */
function duckDuckGoTarget(href: string): string | null {
  if (href.startsWith('http')) return href
  const redirect = parsedUrl(new URL(href, 'https://duckduckgo.com').href)
  const target = redirect?.searchParams.get('uddg')
  if (!target) return null
  return target
}

/** Where a Bing result link goes: direct, or through its `/ck/a?u=a1<base64>` redirect. */
function bingTarget(href: string): string | null {
  const url = parsedUrl(href)
  if (!url) return null
  if (url.hostname !== 'www.bing.com' || !url.pathname.startsWith('/ck/')) return url.href
  const encoded = url.searchParams.get('u')
  if (!encoded || !encoded.startsWith('a1')) return null
  const decoded = Buffer.from(encoded.slice(2), 'base64url').toString('utf8')
  if (!decoded.startsWith('http')) return null
  return decoded
}

function formatResults(results: SearchResult[]): string {
  return results
    .map((result, index) => {
      const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`]
      if (result.snippet) lines.push(`   ${result.snippet}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

function countOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RESULT_COUNT
  return Math.min(Math.max(1, Math.round(value)), MAX_RESULT_COUNT)
}

// ── Fetching ────────────────────────────────────────────────────

/** Fetch a page and hand it back whole, or saved with its outline when it is long. */
async function fetchPage(url: URL, find: string, context: GroveToolContext): Promise<GroveToolResult> {
  const response = await request(url.href, {})
  const contentType = response.headers.get('content-type') ?? ''
  const body = await response.text()
  const page = pageOf(body, contentType, response.url || url.href)
  if (page === null) {
    return { content: `${url.href} is ${contentType || 'not text'}, which web_fetch cannot read.`, isError: true }
  }

  const header = pageHeader(page.title, response.url || url.href)
  if (page.markdown.length <= INLINE_CHARACTERS) return { content: `${header}\n\n${page.markdown}` }

  const path = await savePage(context.sessionId, response.url || url.href, page.markdown)
  const lines = page.markdown.split('\n')
  const parts = [
    header,
    `Saved to ${path} (${lines.length} lines, ${page.markdown.length} characters). Read or grep it for what you need.`,
    `Outline:\n${formatOutline(outlineOf(lines))}`
  ]
  if (find) parts.push(matchingSections(lines, find))
  return { content: parts.join('\n\n') }
}

/** A page's title and its content as Markdown, or null for a body that is not text. */
export function pageOf(
  body: string,
  contentType: string,
  url: string
): { title: string; markdown: string } | null {
  if (contentType === '' || contentType.includes('html')) return htmlPage(body, url)
  if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml')) {
    return { title: '', markdown: body.trim() }
  }
  return null
}

// What is never content: page furniture, and the tooltips and popovers code
// blocks carry (svelte.dev's type hovers), which would read as code.
const NEVER_CONTENT =
  'script, style, noscript, template, svg, iframe, [hidden], [aria-hidden="true"], [role="tooltip"], [class*="popover"], [class*="popup"], [class*="tooltip"]'
const PAGE_FURNITURE = 'nav, footer, header, aside, form'

/**
 * An HTML page's main content as Markdown. Readability picks the article out
 * of the page; when it keeps too little of the text — documentation sites
 * whose code blocks and tables it reads as clutter — the whole body is used.
 */
function htmlPage(html: string, url: string): { title: string; markdown: string } {
  const document = cleanedDocument(html, url)
  const title = cleanText(document.querySelector('title')?.textContent)
  const fullText = cleanText(document.body?.textContent)
  const article = readableArticle(cleanedDocument(html, url))

  let contentHtml = ''
  if (article && cleanText(article.textContent).length >= fullText.length * READABLE_SHARE) {
    contentHtml = article.content
  } else {
    removeAll(document, PAGE_FURNITURE)
    contentHtml = document.body?.innerHTML ?? ''
  }
  let pageTitle = title
  if (article?.title) pageTitle = article.title
  return { title: pageTitle, markdown: toMarkdown(contentHtml) }
}

/** The page parsed, with what is never content taken out and every link made absolute. */
function cleanedDocument(html: string, url: string): Document {
  const { document } = parseHTML(html)
  removeAll(document, NEVER_CONTENT)
  absolutise(document, 'a[href]', 'href', url)
  absolutise(document, 'img[src]', 'src', url)
  return document
}

function removeAll(document: Document, selector: string): void {
  for (const element of document.querySelectorAll(selector)) element.remove()
}

/** Rewrites a relative URL attribute against the page's address; in-page anchors are dropped. */
function absolutise(document: Document, selector: string, attribute: string, url: string): void {
  for (const element of document.querySelectorAll(selector)) {
    const value = element.getAttribute(attribute) ?? ''
    if (value.startsWith('#')) {
      // A heading's own anchor (`#`, `¶`) is noise; a link to elsewhere in the page keeps its text.
      if (cleanText(element.textContent).length <= 1) element.remove()
      else element.removeAttribute(attribute)
      continue
    }
    try {
      element.setAttribute(attribute, new URL(value, url).href)
    } catch {
      element.removeAttribute(attribute)
    }
  }
}

/** Readability's reading of a document, or null when it finds no article. */
function readableArticle(document: Document): { title: string; content: string; textContent: string } | null {
  try {
    const article = new Readability(document).parse()
    if (!article || !article.content) return null
    return { title: article.title ?? '', content: article.content, textContent: article.textContent ?? '' }
  } catch {
    return null
  }
}

// A link with no text — the anchor icons beside headings.
const EMPTY_LINK = /\[\]\([^)]*\)/g

function toMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-'
  })
  turndown.remove(['script', 'style', 'noscript'])
  return turndown
    .turndown(html)
    .replace(EMPTY_LINK, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Write a long page where the agent's read and grep tools can reach it. */
async function savePage(sessionId: string, url: string, markdown: string): Promise<string> {
  const directory = join(tmpdir(), 'grove-web', sessionId)
  await mkdir(directory, { recursive: true })
  const path = join(directory, fileNameOf(url))
  await writeFile(path, markdown)
  return path
}

/** A readable file name for a URL, kept apart from other URLs by a short hash. */
function fileNameOf(url: string): string {
  const parsed = new URL(url)
  const slug = `${parsed.hostname}${parsed.pathname}`
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 8)
  return `${slug}-${hash}.md`
}

function pageHeader(title: string, url: string): string {
  if (title) return `# ${title}\n${url}`
  return url
}

/** The Markdown headings of a page, outside fenced code. */
export function outlineOf(lines: string[]): OutlineEntry[] {
  const outline: OutlineEntry[] = []
  let inFence = false
  lines.forEach((line, index) => {
    if (line.startsWith('```')) inFence = !inFence
    if (inFence) return
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!heading) return
    outline.push({ line: index + 1, level: heading[1].length, text: heading[2].trim() })
  })
  return outline
}

function formatOutline(outline: OutlineEntry[]): string {
  if (outline.length === 0) return '(no headings)'
  return outline.map((entry) => `${'  '.repeat(entry.level - 1)}${entry.line}: ${entry.text}`).join('\n')
}

/**
 * The sections — heading to next heading — that contain any of the words in
 * `find`, most matches first, cut to fit.
 */
export function matchingSections(lines: string[], find: string): string {
  const words = find
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)
  const scored = sectionsOf(lines)
    .map((section) => ({ ...section, score: scoreOf(section.text.toLowerCase(), find.toLowerCase(), words) }))
    .filter((section) => section.score > 0)
    .sort((left, right) => right.score - left.score)
  if (scored.length === 0) return `Nothing matches "${find}".`

  const kept: string[] = []
  let length = 0
  for (const section of scored) {
    if (length + section.text.length > FIND_CHARACTERS && kept.length > 0) break
    kept.push(`[lines ${section.start}-${section.end}]\n${section.text.slice(0, FIND_CHARACTERS)}`)
    length += section.text.length
  }
  return `Sections matching "${find}":\n\n${kept.join('\n\n')}`
}

/** A page split at its headings, with the line range of each part. */
function sectionsOf(lines: string[]): { start: number; end: number; text: string }[] {
  const starts = [0, ...outlineOf(lines).map((entry) => entry.line - 1)].filter(
    (start, index, all) => all.indexOf(start) === index
  )
  return starts.map((start, index) => {
    let end = lines.length
    if (index + 1 < starts.length) end = starts[index + 1]
    return { start: start + 1, end, text: lines.slice(start, end).join('\n').trim() }
  })
}

/**
 * How well a section answers `find`: the whole phrase in its heading counts
 * most, then the phrase anywhere, then each word on its own.
 */
function scoreOf(text: string, phrase: string, words: string[]): number {
  const heading = text.split('\n', 1)[0]
  let score = 0
  if (heading.startsWith('#') && heading.includes(phrase)) score += 50
  score += 10 * occurrences(text, phrase)
  for (const word of words) score += occurrences(text, word)
  return score
}

function occurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0
  return text.split(needle).length - 1
}

// ── Shared ──────────────────────────────────────────────────────

/** A GET or POST as a browser makes it, failing on an error status or a timeout. */
async function request(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(init.headers as Record<string, string> | undefined)
    }
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response
}

function parsedUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url
  } catch {
    return null
  }
}

function cleanText(text: string | null | undefined): string {
  if (!text) return ''
  return text.replace(/\s+/g, ' ').trim()
}
