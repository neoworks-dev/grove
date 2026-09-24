import { describe, it, expect } from 'bun:test'
import { mediaKind, mediaUrl, extensionOf } from '../src/renderer/src/lib/media'
import { fitScale, zoomAbout } from '../src/renderer/src/lib/mediaView'

describe('mediaKind', () => {
  it('sorts media files by the viewer they open in', () => {
    expect(mediaKind('/repo/logo.PNG')).toBe('image')
    expect(mediaKind('/repo/icon.svg')).toBe('image')
    expect(mediaKind('/repo/demo.webm')).toBe('video')
    expect(mediaKind('/repo/beep.mp3')).toBe('audio')
    expect(mediaKind('/repo/spec.pdf')).toBe('pdf')
    expect(mediaKind('/repo/part.3mf')).toBe('model')
    expect(mediaKind('/repo/scene.glb')).toBe('model')
  })

  it('leaves text files to nvim', () => {
    expect(mediaKind('/repo/main.ts')).toBeNull()
    expect(mediaKind('/repo/Makefile')).toBeNull()
    expect(mediaKind('/repo/.png')).toBeNull()
    expect(mediaKind('/repo/scratch://rename')).toBeNull()
  })

  it('is not fooled by names on the object prototype', () => {
    expect(mediaKind('/repo/file.constructor')).toBeNull()
    expect(mediaKind('/repo/file.toString')).toBeNull()
  })
})

describe('extensionOf', () => {
  it('reads the last extension, lowercased', () => {
    expect(extensionOf('/a/b/model.v2.GLTF')).toBe('gltf')
    expect(extensionOf('/a/b.dir/README')).toBe('')
  })
})

describe('mediaUrl', () => {
  it('keeps the path hierarchical and encodes each segment', () => {
    const url = mediaUrl('/home/me/repo', '/home/me/repo', '/home/me/repo/assets/my model/a#1.gltf')
    expect(url).toBe(
      'grove-file://worktree/%2Fhome%2Fme%2Frepo/assets/my%20model/a%231.gltf'
    )
  })

  it('resolves a sidecar file next to the model', () => {
    const url = mediaUrl('wt', '/repo', '/repo/assets/scene.gltf')
    expect(new URL('scene.bin', url ?? '').href).toBe('grove-file://worktree/wt/assets/scene.bin')
  })

  it('refuses a path outside the worktree', () => {
    expect(mediaUrl('wt', '/repo', '/repository/x.png')).toBeNull()
    expect(mediaUrl('wt', '/repo/', '/other/x.png')).toBeNull()
  })
})

describe('fitScale', () => {
  it('shrinks a large image to fit inside the margin', () => {
    expect(fitScale(2000, 1000, 1048, 1048)).toBeCloseTo(0.5)
  })

  it('never enlarges a small image', () => {
    expect(fitScale(16, 16, 800, 600)).toBe(1)
  })
})

describe('zoomAbout', () => {
  it('keeps the point under the cursor fixed', () => {
    const view = { scale: 1, x: 10, y: 20 }
    const zoomed = zoomAbout(view, 2, 110, 120, 0.1, 10)
    // Content point (100, 100) was under (110, 120) and still is.
    expect(zoomed.x + 100 * zoomed.scale).toBeCloseTo(110)
    expect(zoomed.y + 100 * zoomed.scale).toBeCloseTo(120)
  })

  it('holds the scale within its bounds', () => {
    const zoomed = zoomAbout({ scale: 8, x: 0, y: 0 }, 4, 0, 0, 0.1, 10)
    expect(zoomed.scale).toBe(10)
  })
})
