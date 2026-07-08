// file:// URI <-> absolute path conversion. Kept dependency-free so pure
// helpers (edit application, tests) don't pull in CodeMirror.

export function fileUri(path: string): string {
  // Encode each segment; keep the leading slash structure.
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `file://${encoded}`
}

export function uriToPath(uri: string): string {
  const withoutScheme = uri.replace(/^file:\/\//, '')
  return decodeURIComponent(withoutScheme)
}
