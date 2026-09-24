import { describe, it, expect } from 'bun:test'
import { extensionOf, worktreeFileUrl } from '../src/renderer/src/lib/fileUrl'

describe('extensionOf', () => {
  it('reads the last extension, lowercased', () => {
    expect(extensionOf('/a/b/model.v2.GLTF')).toBe('gltf')
  })

  it('has none for a bare name or a dotfile', () => {
    expect(extensionOf('/a/b.dir/README')).toBe('')
    expect(extensionOf('/repo/.png')).toBe('')
  })
})

describe('worktreeFileUrl', () => {
  it('keeps the path hierarchical and encodes each segment', () => {
    const url = worktreeFileUrl(
      '/home/me/repo',
      '/home/me/repo',
      '/home/me/repo/assets/my model/a#1.gltf'
    )
    expect(url).toBe('grove-file://worktree/%2Fhome%2Fme%2Frepo/assets/my%20model/a%231.gltf')
  })

  it('resolves a sidecar file next to the model', () => {
    const url = worktreeFileUrl('wt', '/repo', '/repo/assets/scene.gltf')
    expect(new URL('scene.bin', url ?? '').href).toBe('grove-file://worktree/wt/assets/scene.bin')
  })

  it('refuses a path outside the worktree', () => {
    expect(worktreeFileUrl('wt', '/repo', '/repository/x.png')).toBeNull()
    expect(worktreeFileUrl('wt', '/repo/', '/other/x.png')).toBeNull()
  })
})
