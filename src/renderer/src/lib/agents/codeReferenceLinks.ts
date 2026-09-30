// Turns the paths in a rendered agent message into links to the code.
//
// The message reaches the DOM through {@html}, so — like the code-fence
// highlighting next door — this is an action over what was rendered rather than
// part of the markdown. Streaming rewrites the HTML constantly, hence the
// MutationObserver. Links are made only for files main says exist in the
// worktree; until then a candidate is plain text.

import {
  findCodeReferences,
  parseCodeReference,
  worktreePathOf,
  type CodeReference
} from './codeReferences'

export interface CodeReferenceLinkOptions {
  /** The worktree the session runs in; its path is also its id. */
  root: string
  onOpen: (reference: CodeReference) => void
}

// How long an answer about a path is trusted. Short, since the agent creates and
// deletes files as it goes.
const EXISTENCE_TTL_MS = 30_000

// Streaming rewrites the message many times a second; scanning once it pauses
// is enough.
const SCAN_DELAY_MS = 150

// Text under these is already something else — a link, code, a control.
const SKIPPED_ANCESTORS = 'pre, code, a, button, [data-code-ref]'

const existence = new Map<string, { exists: boolean; checkedAt: number }>()

interface Candidate {
  reference: CodeReference
  relativePath: string
}

type PlacedCandidate = Candidate & { index: number; length: number }

/** A text node, the text it held when scanned, and the paths found in it. */
interface TextCandidates {
  node: Text
  text: string
  candidates: PlacedCandidate[]
}

/** Svelte action: link every path under `container` that names a file in the worktree. */
export function linkCodeReferences(
  container: HTMLElement,
  initial: CodeReferenceLinkOptions
): { update: (next: CodeReferenceLinkOptions) => void; destroy: () => void } {
  let options = initial
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function schedule(): void {
    clearTimeout(timer)
    timer = setTimeout(() => void scan(), SCAN_DELAY_MS)
  }

  /** Finds the candidates, asks which exist, and links those still on screen. */
  async function scan(): Promise<void> {
    const root = options.root
    if (!root) return
    const codes = codeCandidates(container, root)
    const texts = textCandidates(container, root)
    const paths = new Set<string>()
    for (const entry of codes) paths.add(entry.candidate.relativePath)
    for (const entry of texts) {
      for (const candidate of entry.candidates) paths.add(candidate.relativePath)
    }
    if (paths.size === 0) return
    const existing = await existingPaths(root, [...paths])
    if (disposed || root !== options.root) return
    for (const entry of codes) linkCode(entry.element, entry.candidate, existing)
    for (const entry of texts) linkText(entry, existing)
  }

  /** Opens the reference a click or Enter landed on. */
  function open(event: Event): void {
    if (!(event.target instanceof Element)) return
    const link = event.target.closest<HTMLElement>('[data-code-ref]')
    if (!link || !container.contains(link)) return
    if (event instanceof KeyboardEvent && event.key !== 'Enter') return
    event.preventDefault()
    options.onOpen(referenceFrom(link))
  }

  const observer = new MutationObserver(schedule)
  observer.observe(container, { childList: true, subtree: true, characterData: true })
  container.addEventListener('click', open)
  container.addEventListener('keydown', open)
  schedule()

  return {
    update(next) {
      options = next
      schedule()
    },
    destroy() {
      disposed = true
      clearTimeout(timer)
      observer.disconnect()
      container.removeEventListener('click', open)
      container.removeEventListener('keydown', open)
    }
  }
}

/** Inline code (not code blocks) whose whole text is a path. */
function codeCandidates(
  container: HTMLElement,
  root: string
): { element: HTMLElement; candidate: Candidate }[] {
  const found: { element: HTMLElement; candidate: Candidate }[] = []
  for (const element of container.querySelectorAll<HTMLElement>('code:not([data-code-ref])')) {
    if (element.closest('pre, a, button')) continue
    const candidate = candidateOf(parseCodeReference(element.textContent ?? ''), root)
    if (candidate) found.push({ element, candidate })
  }
  return found
}

/** Text nodes of prose, with the paths each one names. */
function textCandidates(container: HTMLElement, root: string): TextCandidates[] {
  const found: TextCandidates[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (text.parentElement?.closest(SKIPPED_ANCESTORS)) continue
    const candidates: PlacedCandidate[] = []
    for (const reference of findCodeReferences(text.data)) {
      const candidate = candidateOf(reference, root)
      if (candidate)
        candidates.push({ ...candidate, index: reference.index, length: reference.length })
    }
    if (candidates.length > 0) found.push({ node: text, text: text.data, candidates })
  }
  return found
}

/** The candidate a parsed reference makes, or null when it is outside the worktree. */
function candidateOf(reference: CodeReference | null, root: string): Candidate | null {
  if (!reference) return null
  const relativePath = worktreePathOf(reference.path, root)
  if (relativePath === null) return null
  return { reference: { ...reference, path: relativePath }, relativePath }
}

/** Of the paths, the ones that are files in the worktree, answering from the cache where it can. */
async function existingPaths(root: string, paths: string[]): Promise<Set<string>> {
  const now = Date.now()
  const known = new Set<string>()
  const unknown: string[] = []
  for (const path of paths) {
    const cached = existence.get(`${root}\0${path}`)
    if (cached && now - cached.checkedAt < EXISTENCE_TTL_MS) {
      if (cached.exists) known.add(path)
      continue
    }
    unknown.push(path)
  }
  if (unknown.length === 0) return known
  const found = await window.workbench.files.existing(root, unknown).catch(() => [] as string[])
  const foundSet = new Set(found)
  for (const path of unknown) {
    existence.set(`${root}\0${path}`, { exists: foundSet.has(path), checkedAt: now })
    if (foundSet.has(path)) known.add(path)
  }
  return known
}

/** Makes inline code a link, when the file it names exists and it is still on screen. */
function linkCode(element: HTMLElement, candidate: Candidate, existing: Set<string>): void {
  if (!element.isConnected || !existing.has(candidate.relativePath)) return
  if (element.hasAttribute('data-code-ref')) return
  markAsLink(element, candidate.reference)
}

/** Wraps the references in a text node that name existing files, when the node is unchanged. */
function linkText(entry: TextCandidates, existing: Set<string>): void {
  const { node, text } = entry
  // The text may have moved on while the lookup ran.
  if (!node.isConnected || !node.parentNode || node.data !== text) return
  const linked = entry.candidates.filter((candidate) => existing.has(candidate.relativePath))
  if (linked.length === 0) return
  const fragment = document.createDocumentFragment()
  let cursor = 0
  for (const candidate of linked) {
    const end = candidate.index + candidate.length
    fragment.append(text.slice(cursor, candidate.index))
    const link = document.createElement('span')
    link.textContent = text.slice(candidate.index, end)
    markAsLink(link, candidate.reference)
    fragment.append(link)
    cursor = end
  }
  fragment.append(text.slice(cursor))
  node.parentNode.replaceChild(fragment, node)
}

/** Gives an element the reference and the link semantics; the look is `[data-code-ref]` in CSS. */
function markAsLink(element: HTMLElement, reference: CodeReference): void {
  element.dataset.codeRef = reference.path
  if (reference.line !== undefined) element.dataset.line = String(reference.line)
  if (reference.endLine !== undefined) element.dataset.endLine = String(reference.endLine)
  element.setAttribute('role', 'link')
  element.tabIndex = 0
  element.title = `Open ${reference.path}`
}

/** The reference a link element carries. */
function referenceFrom(link: HTMLElement): CodeReference {
  const reference: CodeReference = { path: link.dataset.codeRef ?? '' }
  if (link.dataset.line) reference.line = Number(link.dataset.line)
  if (link.dataset.endLine) reference.endLine = Number(link.dataset.endLine)
  return reference
}
