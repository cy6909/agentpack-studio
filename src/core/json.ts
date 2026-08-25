import { createHash } from 'node:crypto'
import { AgentPackError } from './errors.js'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (typeof value !== 'object' || value === null) return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  )
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function parseJsonObject(text: string, label: string): JsonObject {
  const trimmed = text.trim()
  const normalized = trimmed.startsWith('```json') && trimmed.endsWith('```')
    ? trimmed.slice('```json'.length, -3).trim()
    : trimmed

  let parsed: unknown
  try {
    parsed = JSON.parse(normalized)
  } catch (cause) {
    throw new AgentPackError('OUTPUT_INVALID', `${label} is not valid JSON`, { text: trimmed }, { cause })
  }
  if (!isJsonObject(parsed)) {
    throw new AgentPackError('OUTPUT_INVALID', `${label} must be a JSON object`, { parsed })
  }
  return parsed
}

export function readJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document
  if (!pointer.startsWith('/')) {
    throw new AgentPackError('PACK_INVALID', `JSON Pointer must start with '/': ${pointer}`)
  }
  return pointer
    .slice(1)
    .split('/')
    .map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((current, token) => {
      if (Array.isArray(current)) {
        const index = Number(token)
        return Number.isInteger(index) ? current[index] : undefined
      }
      return isJsonObject(current) ? current[token] : undefined
    }, document)
}
