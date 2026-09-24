import { describe, it, expect } from 'bun:test'
import { pickViewer, type FileViewer } from '../src/renderer/src/lib/fileViewer'

/** A viewer that is never loaded; only its claim matters here. */
function viewer(id: string, extensions: string[], priority?: number): FileViewer {
  return {
    id,
    label: id,
    extensions,
    priority,
    load: () => Promise.reject(new Error('not loaded in tests'))
  }
}

describe('pickViewer', () => {
  const image = viewer('image', ['png', 'svg'])
  const pdf = viewer('pdf', ['pdf'])

  it('picks the viewer claiming the extension, case aside', () => {
    expect(pickViewer([image, pdf], '/repo/Logo.PNG')).toBe(image)
    expect(pickViewer([image, pdf], '/repo/spec.pdf')).toBe(pdf)
  })

  it('leaves unclaimed and extensionless files to nvim', () => {
    expect(pickViewer([image, pdf], '/repo/main.ts')).toBeNull()
    expect(pickViewer([image, pdf], '/repo/Makefile')).toBeNull()
    expect(pickViewer([image, pdf], '/repo/.png')).toBeNull()
  })

  it('lets the newest registration win a tie', () => {
    const pluginSvg = viewer('plugin.svg', ['svg'])
    expect(pickViewer([image, pluginSvg], '/repo/a.svg')).toBe(pluginSvg)
  })

  it('lets a higher priority beat a newer registration', () => {
    const preferred = viewer('preferred', ['svg'], 10)
    const later = viewer('later', ['svg'])
    expect(pickViewer([preferred, later], '/repo/a.svg')).toBe(preferred)
  })
})
