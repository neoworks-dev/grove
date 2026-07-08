// JSON-schema → zod raw shape converter for plugin MCP tools. Supports the
// documented subset: object properties of string/number/boolean/enum/array
// (of those) with a required list; everything else degrades to z.any().

import { z, type ZodType } from 'zod'

export interface JsonSchemaObject {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

interface JsonSchemaProperty {
  type?: string
  description?: string
  enum?: unknown[]
  items?: JsonSchemaProperty
}

function convertProperty(property: JsonSchemaProperty): ZodType {
  if (Array.isArray(property.enum) && property.enum.length > 0) {
    const values = property.enum.filter((value) => typeof value === 'string') as string[]
    if (values.length > 0) return z.enum(values as [string, ...string[]])
  }
  if (property.type === 'string') return z.string()
  if (property.type === 'number' || property.type === 'integer') return z.number()
  if (property.type === 'boolean') return z.boolean()
  if (property.type === 'array') {
    const items = property.items ? convertProperty(property.items) : z.any()
    return z.array(items)
  }
  return z.any()
}

export function zodShapeFromJsonSchema(schema: JsonSchemaObject): Record<string, ZodType> {
  const shape: Record<string, ZodType> = {}
  const required = new Set(schema.required ?? [])
  for (const [key, raw] of Object.entries(schema.properties ?? {})) {
    const property = (raw ?? {}) as JsonSchemaProperty
    let type = convertProperty(property)
    if (typeof property.description === 'string') type = type.describe(property.description)
    if (!required.has(key)) type = type.optional()
    shape[key] = type
  }
  return shape
}
