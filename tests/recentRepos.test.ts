import { describe, expect, test } from 'bun:test'
import { withRecent } from '../src/main/recentRepos'

describe('withRecent', () => {
  test('puts a new repository first', () => {
    expect(withRecent(['/a', '/b'], '/c')).toEqual(['/c', '/a', '/b'])
  })

  test('moves a repository already listed to the front instead of repeating it', () => {
    expect(withRecent(['/a', '/b', '/c'], '/b')).toEqual(['/b', '/a', '/c'])
  })

  test('drops the oldest past ten', () => {
    const ten = Array.from({ length: 10 }, (_, index) => `/repo${index}`)
    const next = withRecent(ten, '/new')
    expect(next).toHaveLength(10)
    expect(next[0]).toBe('/new')
    expect(next).not.toContain('/repo9')
  })
})
