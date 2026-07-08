// Minimal path helpers for the renderer (no Node 'path' module here).

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/')
}

export function joinPath(base: string, relative: string): string {
  if (base.length === 0) return relative
  if (base.endsWith('/')) return base + relative
  return `${base}/${relative}`
}
