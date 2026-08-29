// JSON Schema to TypeBox, for harnesses that describe tool parameters that way.
//
// grove writes its tool schemas as plain JSON Schema because that is what most
// runtimes take; pi wants a TypeBox schema, which validates with its own symbol
// metadata rather than by reading the object. Only the shapes grove's own tools
// use are handled — anything unrecognised becomes `Type.Any()`, which accepts
// the value and lets the tool validate it itself.

import { Type } from 'typebox'
import type { TSchema } from 'typebox'

interface JsonSchemaNode {
  type?: string
  description?: string
  enum?: unknown[]
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
}

/** Convert a JSON Schema object into the TypeBox schema pi validates against. */
export function jsonSchemaToTypebox(schema: Record<string, unknown>): TSchema {
  return convert(schema as JsonSchemaNode)
}

function convert(node: JsonSchemaNode): TSchema {
  const options: Record<string, unknown> = {}
  if (node.description !== undefined) options.description = node.description

  if (Array.isArray(node.enum)) {
    return Type.Union(
      node.enum.map((value) => Type.Literal(value as string)),
      options
    )
  }
  if (node.type === 'object') return convertObject(node, options)
  if (node.type === 'array') return Type.Array(convert(node.items ?? {}), options)
  if (node.type === 'string') return Type.String(options)
  if (node.type === 'number' || node.type === 'integer') return Type.Number(options)
  if (node.type === 'boolean') return Type.Boolean(options)
  return Type.Any(options)
}

function convertObject(node: JsonSchemaNode, options: Record<string, unknown>): TSchema {
  const required = new Set(node.required ?? [])
  const shape: Record<string, TSchema> = {}
  for (const [key, property] of Object.entries(node.properties ?? {})) {
    const converted = convert(property)
    shape[key] = required.has(key) ? converted : Type.Optional(converted)
  }
  return Type.Object(shape, options)
}
