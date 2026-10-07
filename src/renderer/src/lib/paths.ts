// Minimal path helpers for the renderer (no Node 'path' module here).

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/')
}

export function joinPath(base: string, relative: string): string {
  if (base.length === 0) return relative
  if (base.endsWith('/')) return base + relative
  return `${base}/${relative}`
}

// Strip the worktree base from an absolute path. Returns the path unchanged when
// it lies outside the base (nothing sensible to relativize against).
export function relativePath(base: string, absolute: string): string {
  if (base.length === 0) return absolute
  const prefix = base.endsWith('/') ? base : `${base}/`
  if (!absolute.startsWith(prefix)) return absolute
  return absolute.slice(prefix.length)
}

/**
 * The path as a normalized worktree-relative path, or null when it lies outside
 * the worktree. Relative paths are taken against the worktree, and `.`/`..`
 * segments are resolved, so `../sibling/a.ts` and `<root>/../sibling/a.ts` are
 * both caught. The root itself comes back as ''.
 */
export function relativeInside(base: string, path: string): string | null {
  let full = path
  if (!isAbsolutePath(path)) {
    full = joinPath(base, path)
  }
  const normalized = normalizeSegments(full)
  const root = normalizeSegments(base)
  if (normalized === null || root === null) {
    return null
  }
  if (normalized === root) {
    return ''
  }
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (!normalized.startsWith(prefix)) {
    return null
  }
  return normalized.slice(prefix.length)
}

/** Resolves `.` and `..` in an absolute path; null when `..` climbs past `/`. */
function normalizeSegments(path: string): string | null {
  const kept: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment !== '..') {
      kept.push(segment)
      continue
    }
    if (kept.length === 0) {
      return null
    }
    kept.pop()
  }
  return `/${kept.join('/')}`
}
