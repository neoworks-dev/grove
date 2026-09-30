// JSON-schema → zod raw shape converter for plugin MCP tools. Supports the
// documented subset: object properties of string/number/boolean/enum, arrays of
// those, and nested objects of the same, with a required list; everything else
// degrades to z.any().
//
// The shape is also what the model is shown as the tool's input schema, so a
// nested object that degrades to z.any() reaches it with no fields at all — and
// it guesses them.

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
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: unknown
}

/** One property's zod type. */
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
  if (property.type === 'object' && property.properties) return convertObject(property)
  return z.any()
}

/** A nested object, closed to other keys when the schema says so. */
function convertObject(property: JsonSchemaProperty): ZodType {
  const shape = zodShapeFromJsonSchema({
    type: 'object',
    properties: property.properties,
    required: property.required
  })
  if (property.additionalProperties === false) return z.object(shape).strict()
  return z.object(shape)
}

/** The zod shape of an object schema's properties, descriptions included. */
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
