// Files nvim cannot sensibly show as text. The editor pane keeps them in its
// tab strip like any other file, but draws a viewer over nvim instead of
// :edit-ing their bytes. Decided by extension alone, so a tab restored from
// disk or entered with `:e` is classified the same way as a fresh open.

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'model'

const KIND_BY_EXTENSION = new Map<string, MediaKind>(
  Object.entries({
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
    avif: 'image',
    bmp: 'image',
    ico: 'image',
    svg: 'image',
    mp4: 'video',
    m4v: 'video',
    webm: 'video',
    mov: 'video',
    ogv: 'video',
    mp3: 'audio',
    wav: 'audio',
    ogg: 'audio',
    oga: 'audio',
    flac: 'audio',
    m4a: 'audio',
    aac: 'audio',
    opus: 'audio',
    pdf: 'pdf',
    glb: 'model',
    gltf: 'model',
    stl: 'model',
    obj: 'model',
    ply: 'model',
    fbx: 'model',
    '3mf': 'model'
  } satisfies Record<string, MediaKind>)
)

/** The viewer a file opens in, or null when nvim should edit it as text. */
export function mediaKind(path: string): MediaKind | null {
  const kind = KIND_BY_EXTENSION.get(extensionOf(path))
  if (kind === undefined) return null
  return kind
}

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
export function mediaUrl(worktreeId: string, worktreeRoot: string, path: string): string | null {
  const root = worktreeRoot.replace(/[\\/]+$/, '')
  if (!path.startsWith(`${root}/`)) return null
  const segments = path.slice(root.length + 1).split('/')
  const encodedPath = segments.map(encodeURIComponent).join('/')
  return `grove-file://worktree/${encodeURIComponent(worktreeId)}/${encodedPath}`
}
