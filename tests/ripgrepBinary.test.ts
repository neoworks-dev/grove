import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import { unpackedPath } from '../src/main/ripgrepBinary'

describe('unpackedPath', () => {
  test('points a binary inside app.asar at its unpacked copy', () => {
    const packed = join('/opt/grove/resources/app.asar', 'node_modules/@vscode/ripgrep-linux-x64/bin/rg')
    expect(unpackedPath(packed)).toBe(
      join('/opt/grove/resources/app.asar.unpacked', 'node_modules/@vscode/ripgrep-linux-x64/bin/rg')
    )
  })

  test('leaves a path outside the archive alone', () => {
    const plain = '/home/me/grove/node_modules/@vscode/ripgrep-linux-x64/bin/rg'
    expect(unpackedPath(plain)).toBe(plain)
  })

  test('leaves an already unpacked path alone', () => {
    const unpacked = '/opt/grove/resources/app.asar.unpacked/node_modules/rg'
    expect(unpackedPath(unpacked)).toBe(unpacked)
  })
})
