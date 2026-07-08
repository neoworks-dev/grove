import { describe, it, expect } from 'bun:test'
import { validateManifest, isValidActivationEvent } from '../sdk/src/protocol'

const valid = {
  id: 'grove.file-finder',
  name: 'File Finder',
  version: '1.0.0',
  entry: 'dist/extension.js',
  permissions: ['workspace.read'],
  activation: ['onCommand:files.find', 'onOverlay:fileFinder'],
  contributes: {
    commands: [{ id: 'files.find', title: 'Go to File' }],
    keybindings: [
      { id: 'leader.files', keys: 'leader space', description: 'Search files', command: 'files.find' }
    ],
    overlays: [{ id: 'fileFinder', title: 'Search files by name…' }]
  }
}

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    const result = validateManifest(valid)
    expect(result.ok).toBe(true)
  })

  it('rejects non-objects', () => {
    expect(validateManifest(null).ok).toBe(false)
    expect(validateManifest([]).ok).toBe(false)
    expect(validateManifest('x').ok).toBe(false)
  })

  it('rejects bad ids, versions, and entries', () => {
    const badId = validateManifest({ ...valid, id: 'Bad Id!' })
    expect(badId.ok).toBe(false)
    const badVersion = validateManifest({ ...valid, version: 'one' })
    expect(badVersion.ok).toBe(false)
    const escape = validateManifest({ ...valid, entry: '../outside.js' })
    expect(escape.ok).toBe(false)
    const absolute = validateManifest({ ...valid, entry: '/etc/passwd' })
    expect(absolute.ok).toBe(false)
  })

  it('rejects unknown permissions and activation events', () => {
    const badPermission = validateManifest({ ...valid, permissions: ['fs.everything'] })
    expect(badPermission.ok).toBe(false)
    const badActivation = validateManifest({ ...valid, activation: ['onBoot'] })
    expect(badActivation.ok).toBe(false)
  })

  it('rejects unknown contribution points and entries without ids', () => {
    const unknownPoint = validateManifest({ ...valid, contributes: { gadgets: [] } })
    expect(unknownPoint.ok).toBe(false)
    const missingId = validateManifest({
      ...valid,
      contributes: { commands: [{ title: 'No id' }] }
    })
    expect(missingId.ok).toBe(false)
  })

  it('collects multiple errors at once', () => {
    const result = validateManifest({ id: 'Bad Id!', version: 'x' })
    if (result.ok) throw new Error('expected failure')
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })
})

describe('isValidActivationEvent', () => {
  it('accepts onStartup and prefixed events with payloads', () => {
    expect(isValidActivationEvent('onStartup')).toBe(true)
    expect(isValidActivationEvent('onCommand:files.find')).toBe(true)
    expect(isValidActivationEvent('onPane:my.pane')).toBe(true)
  })
  it('rejects empty payloads and unknown prefixes', () => {
    expect(isValidActivationEvent('onCommand:')).toBe(false)
    expect(isValidActivationEvent('onBoot')).toBe(false)
  })
})
