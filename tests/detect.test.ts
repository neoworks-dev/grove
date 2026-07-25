import { describe, it, expect } from 'bun:test'
import { rewritePort, forcePort, localhostUrl, PORT_PLACEHOLDER } from '../src/main/detect/ports'
import { parsePackageScripts } from '../src/main/detect/packageScripts'
import { parseProcfile } from '../src/main/detect/procfile'
import { parseCompose } from '../src/main/detect/compose'
import { parseMakefile } from '../src/main/detect/makefile'

describe('rewritePort', () => {
  it('replaces a --port flag and reports the original', () => {
    const result = rewritePort('vite --port 5173')
    expect(result.command).toBe(`vite --port ${PORT_PLACEHOLDER}`)
    expect(result.style).toBe('flag')
    expect(result.originalPort).toBe(5173)
  })

  it('handles the --port=N form', () => {
    expect(rewritePort('vite --port=5173').command).toBe(`vite --port=${PORT_PLACEHOLDER}`)
  })

  it('recognises a PORT env assignment as env style', () => {
    const result = rewritePort('PORT=3000 node server.js')
    expect(result.command).toBe(`PORT=${PORT_PLACEHOLDER} node server.js`)
    expect(result.style).toBe('env')
  })

  it('replaces only the first port so a second stays for the user to decide', () => {
    const result = rewritePort('node --inspect=9229 server.js --port 3000')
    expect(result.command).toContain('9229')
    expect(result.command).toContain(PORT_PLACEHOLDER)
  })

  it('reports none when there is no port', () => {
    const result = rewritePort('node server.js')
    expect(result.command).toBe('node server.js')
    expect(result.style).toBe('none')
    expect(result.originalPort).toBe(null)
  })

  it('ignores out-of-range numbers', () => {
    expect(rewritePort('tool --port 99999').style).toBe('none')
  })
})

describe('forcePort', () => {
  it('passes a flag through a package runner', () => {
    expect(forcePort('bun run dev', 'flag', true)).toBe(`bun run dev -- --port ${PORT_PLACEHOLDER}`)
  })

  it('appends the flag directly when there is no runner to pass through', () => {
    expect(forcePort('vite', 'flag', false)).toBe(`vite --port ${PORT_PLACEHOLDER}`)
  })

  it('exports PORT when the command has no port flag', () => {
    expect(forcePort('make serve', 'none', false)).toBe(`PORT=${PORT_PLACEHOLDER} make serve`)
  })
})

describe('parsePackageScripts', () => {
  const manifest = JSON.stringify({
    scripts: {
      dev: 'vite --port 5173',
      build: 'vite build',
      test: 'bun test',
      lint: 'eslint .'
    }
  })

  it('proposes long-running scripts and skips one-shot ones', () => {
    const proposals = parsePackageScripts({ 'package.json': manifest })
    const names = proposals.map((proposal) => proposal.name)
    expect(names).toContain('dev')
    expect(names).not.toContain('build')
    expect(names).not.toContain('lint')
  })

  it('picks the runner from the lockfile', () => {
    const withBun = parsePackageScripts({ 'package.json': manifest, 'bun.lock': '' })
    expect(withBun[0].command).toStartWith('bun run dev')

    const withPnpm = parsePackageScripts({ 'package.json': manifest, 'pnpm-lock.yaml': '' })
    expect(withPnpm[0].command).toStartWith('pnpm run dev')
  })

  it('defaults to npm when no lockfile is present', () => {
    const proposals = parsePackageScripts({ 'package.json': manifest })
    expect(proposals[0].command).toStartWith('npm run dev')
  })

  it('overrides a script-level port flag via passthrough', () => {
    const proposals = parsePackageScripts({ 'package.json': manifest, 'bun.lock': '' })
    expect(proposals[0].command).toBe(`bun run dev -- --port ${PORT_PLACEHOLDER}`)
    expect(proposals[0].usesPort).toBe(true)
    expect(proposals[0].preview).toBe(localhostUrl())
  })

  it('exports PORT when the script names no port', () => {
    const noPort = JSON.stringify({ scripts: { start: 'node server.js' } })
    const proposals = parsePackageScripts({ 'package.json': noPort })
    expect(proposals[0].command).toBe(`PORT=${PORT_PLACEHOLDER} npm run start`)
  })

  it('returns nothing for a missing or unparseable manifest', () => {
    expect(parsePackageScripts({})).toEqual([])
    expect(parsePackageScripts({ 'package.json': '{ broken' })).toEqual([])
    expect(parsePackageScripts({ 'package.json': '{}' })).toEqual([])
  })
})

describe('parseProcfile', () => {
  it('proposes every entry, substituting the port in place', () => {
    const proposals = parseProcfile({
      Procfile: ['# comment', 'web: bundle exec puma -p 3000', '', 'worker: rake jobs:work'].join(
        '\n'
      )
    })

    expect(proposals).toHaveLength(2)
    expect(proposals[0].name).toBe('web')
    expect(proposals[0].command).toBe(`bundle exec puma -p ${PORT_PLACEHOLDER}`)
    expect(proposals[1].name).toBe('worker')
    expect(proposals[1].command).toBe(`PORT=${PORT_PLACEHOLDER} rake jobs:work`)
  })

  it('returns nothing without a Procfile', () => {
    expect(parseProcfile({})).toEqual([])
  })
})

describe('parseCompose', () => {
  const compose = `
services:
  web:
    image: nginx
    ports:
      - "8080:80"
  db:
    image: postgres
`

  it('proposes one service per compose entry, driving compose itself', () => {
    const proposals = parseCompose({ 'docker-compose.yml': compose })
    expect(proposals.map((proposal) => proposal.name)).toEqual(['web', 'db'])
    expect(proposals[0].command).toBe('docker compose -f docker-compose.yml up --no-deps web')
  })

  it('points preview at the published host port', () => {
    const proposals = parseCompose({ 'docker-compose.yml': compose })
    expect(proposals[0].preview).toBe('http://localhost:8080')
    expect(proposals[1].preview).toBeUndefined()
  })

  it('never claims a Grove port — compose pins its own', () => {
    const proposals = parseCompose({ 'docker-compose.yml': compose })
    expect(proposals.every((proposal) => proposal.usesPort === false)).toBe(true)
  })

  it('handles a host-bound mapping', () => {
    const bound = 'services:\n  web:\n    ports:\n      - "127.0.0.1:9000:80"\n'
    expect(parseCompose({ 'compose.yaml': bound })[0].preview).toBe('http://localhost:9000')
  })

  it('returns nothing for a missing or unparseable file', () => {
    expect(parseCompose({})).toEqual([])
    expect(parseCompose({ 'docker-compose.yml': 'services:\n  - [unclosed' })).toEqual([])
  })
})

describe('parseMakefile', () => {
  const makefile = [
    '.PHONY: build serve',
    '',
    'build:',
    '\tgo build ./...',
    '',
    'serve:',
    '\tgo run ./cmd/server',
    '',
    'test:',
    '\tgo test ./...'
  ].join('\n')

  it('proposes only service-shaped targets', () => {
    const proposals = parseMakefile({ Makefile: makefile })
    expect(proposals.map((proposal) => proposal.name)).toEqual(['serve'])
    expect(proposals[0].command).toBe(`PORT=${PORT_PLACEHOLDER} make serve`)
  })

  it('ignores recipe lines and variable assignments', () => {
    const withVars = ['CC := gcc', 'dev:', '\t$(CC) -o app', ''].join('\n')
    const proposals = parseMakefile({ Makefile: withVars })
    expect(proposals.map((proposal) => proposal.name)).toEqual(['dev'])
  })

  it('returns nothing without a Makefile', () => {
    expect(parseMakefile({})).toEqual([])
  })
})
