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

/**
 * Normalize a model response that contains exactly one top-level JSON object.
 * Some OpenAI-compatible model servers occasionally preserve analysis prose
 * or Markdown fences even when the prompt asks for bare JSON. The adapter may
 * remove that presentation noise, but it must reject zero or multiple valid
 * objects so it never guesses which payload is authoritative.
 */
export function extractUniqueJsonObject(text: string, label: string): JsonObject {
  try {
    return parseJsonObject(text, label)
  } catch (cause) {
    if (!(cause instanceof AgentPackError) || cause.code !== 'OUTPUT_INVALID') throw cause
  }

  const candidates: JsonObject[] = []
  for (const slice of topLevelObjectSlices(text)) {
    try {
      const parsed: unknown = JSON.parse(slice)
      if (isJsonObject(parsed)) candidates.push(parsed)
    } catch {
      // An object-looking prose fragment is not an authoritative candidate.
    }
  }
  if (candidates.length === 1) return candidates[0]!
  throw new AgentPackError(
    'OUTPUT_INVALID',
    candidates.length === 0
      ? `${label} does not contain a valid JSON object`
      : `${label} contains multiple JSON objects`,
    { text: text.trim(), candidateCount: candidates.length },
  )
}

function topLevelObjectSlices(text: string): string[] {
  const slices: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"' && depth > 0) {
      inString = true
      continue
    }
    if (character === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (character !== '}' || depth === 0) continue
    depth -= 1
    if (depth === 0 && start >= 0) {
      slices.push(text.slice(start, index + 1))
      start = -1
    }
  }
  return slices
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
