import { describe, it, expect } from 'bun:test'
import { z } from 'zod'
import { zodShapeFromJsonSchema } from '../src/main/plugins/zodSchema'

describe('zodShapeFromJsonSchema', () => {
  const shape = zodShapeFromJsonSchema({
    type: 'object',
    properties: {
      name: { type: 'string', description: 'a name' },
      count: { type: 'integer' },
      flag: { type: 'boolean' },
      kind: { type: 'string', enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'string' } },
      anything: {}
    },
    required: ['name', 'kind']
  })

  it('validates a conforming object', () => {
    const parsed = z.object(shape).parse({
      name: 'x',
      kind: 'a',
      count: 3,
      flag: true,
      tags: ['t']
    })
    expect(parsed.name).toBe('x')
  })

  it('enforces required fields and enum membership', () => {
    expect(() => z.object(shape).parse({ kind: 'a' })).toThrow()
    expect(() => z.object(shape).parse({ name: 'x', kind: 'z' })).toThrow()
  })

  it('leaves optional fields optional and unknown types permissive', () => {
    const parsed = z.object(shape).parse({ name: 'x', kind: 'b', anything: { nested: 1 } })
    expect(parsed.count).toBeUndefined()
  })

  it('rejects wrong primitive and array item types', () => {
    expect(() => z.object(shape).parse({ name: 1, kind: 'a' })).toThrow()
    expect(() => z.object(shape).parse({ name: 'x', kind: 'a', tags: [1] })).toThrow()
  })
})
