// Starting zsh and bash with grove's prompt markers, and leaving other shells be.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withShellIntegration, writeShellIntegration } from '../src/main/terminals/shellIntegration'

describe('shell integration', () => {
  test('zsh starts from grove’s ZDOTDIR, remembering the user’s', () => {
    const launch = withShellIntegration({ SHELL: '/usr/bin/zsh', HOME: '/home/u' }, '/grove/si')
    expect(launch.env.ZDOTDIR).toBe('/grove/si/zsh')
    expect(launch.env.GROVE_USER_ZDOTDIR).toBe('/home/u')
    expect(launch.args).toBeUndefined()
    expect(withShellIntegration({ SHELL: 'zsh', HOME: '/home/u', ZDOTDIR: '/home/u/.config/zsh' }, '/g').env.GROVE_USER_ZDOTDIR).toBe('/home/u/.config/zsh')
  })

  test('bash starts with grove’s init file; fish and others as they are', () => {
    expect(withShellIntegration({ SHELL: '/bin/bash' }, '/g').args).toEqual(['--init-file', '/g/bash/grove.bash', '-i'])
    expect(withShellIntegration({ SHELL: '/bin/fish' }, '/g')).toEqual({ env: { SHELL: '/bin/fish' } })
  })

  test('writes the startup files, each loading the user’s own first', () => {
    const directory = mkdtempSync(join(tmpdir(), 'grove-shell-integration-'))
    try {
      writeShellIntegration(directory)
      for (const file of ['zsh/.zshenv', 'zsh/.zprofile', 'zsh/.zshrc', 'bash/grove.bash']) {
        expect(existsSync(join(directory, file))).toBe(true)
      }
      const zshrc = readFileSync(join(directory, 'zsh/.zshrc'), 'utf8')
      expect(zshrc.indexOf('. $ZDOTDIR/.zshrc')).toBeLessThan(zshrc.indexOf('add-zsh-hook precmd'))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
