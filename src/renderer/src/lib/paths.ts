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
