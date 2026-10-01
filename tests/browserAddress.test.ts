// Where the Browser pane starts, what an address typed into it means, and how
// an element the user points at reads in the composer.

import { describe, expect, test } from 'bun:test'
import type { ServiceRuntime } from '../src/shared/types'
import {
  addressOf,
  describePickedElement,
  startingUrl
} from '../src/renderer/src/kernel/plugins/browser/browserAddress'

/** A service with a preview address in the given state. */
function service(name: string, status: ServiceRuntime['status'], previewUrl: string | null): ServiceRuntime {
  return { worktreeId: '/w', name, status, pid: null, previewUrl, healthUrl: null, logPath: '', ports: [] }
}

describe('where a preview starts', () => {
  test('where it was last, before any service', () => {
    expect(startingUrl('http://localhost:3100/settings', [service('web', 'running', 'http://localhost:3100')])).toBe(
      'http://localhost:3100/settings'
    )
  })

  test('a running service’s preview before a stopped one’s', () => {
    const services = [
      service('docs', 'stopped', 'http://localhost:3101'),
      service('web', 'running', 'http://localhost:3100'),
      service('worker', 'running', null)
    ]
    expect(startingUrl(undefined, services)).toBe('http://localhost:3100')
    expect(startingUrl(undefined, [services[0]])).toBe('http://localhost:3101')
  })

  test('nowhere, without either', () => {
    expect(startingUrl(undefined, [service('worker', 'running', null)])).toBe('')
  })
})

describe('an address typed into the bar', () => {
  test('a local host is http, anything else https, a scheme as written', () => {
    expect(addressOf('localhost:3000')).toBe('http://localhost:3000')
    expect(addressOf('127.0.0.1:8080/app')).toBe('http://127.0.0.1:8080/app')
    expect(addressOf(':5173')).toBe('http://localhost:5173')
    expect(addressOf('example.com')).toBe('https://example.com')
    expect(addressOf('http://example.com')).toBe('http://example.com')
    expect(addressOf('  ')).toBe('')
  })
})

describe('a picked element in the composer', () => {
  test('its selector, its name and where it is', () => {
    expect(
      describePickedElement({ selector: '#save', name: 'Save', url: 'http://localhost:3000/' })
    ).toBe('the element `#save` (“Save”) in the browser preview at http://localhost:3000/ ')
  })
})
