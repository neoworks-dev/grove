// How the renderer names a worktree file by URL: the grove-file:// scheme main
// serves, for anything that loads a file itself — an <img>, a <video>, a model
// loader, a plugin's viewer.

/** The lowercase extension of a path, without its dot; empty when it has none. */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

/**
 * The grove-file:// URL main serves `path` from, or null when it lies outside
 * the worktree. Each segment is encoded on its own so the URL stays
 * hierarchical: a model's sidecar files resolve relative to it.
 */
export function worktreeFileUrl(
  worktreeId: string,
  worktreeRoot: string,
  path: string
): string | null {
  const root = worktreeRoot.replace(/[\\/]+$/, '')
  if (!path.startsWith(`${root}/`)) return null
  const segments = path.slice(root.length + 1).split('/')
  const encodedPath = segments.map(encodeURIComponent).join('/')
  return `grove-file://worktree/${encodeURIComponent(worktreeId)}/${encodedPath}`
}
