import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { AgentPackError } from './errors.js'
import type { JsonObject, JsonValue } from './json.js'
import { isJsonObject, sha256 } from './json.js'
import { VERSION_LOCK } from '../version-lock.js'

const semverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
const packNamePattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const identifierPattern = /^[a-z][a-z0-9-]*$/
const jsonSchema = z.custom<JsonObject>(isJsonObject, 'must be a JSON Schema object')
const jsonValue = z.custom<JsonValue>(value => {
  try {
    JSON.stringify(value)
    return value !== undefined
  } catch {
    return false
  }
}, 'must be JSON-serializable')

const sourceBindingSchema = z.union([
  z.object({ from: z.string().startsWith('/') }).strict(),
  z.object({ value: jsonValue }).strict(),
])

const childSchema = z.object({
  id: z.string().regex(identifierPattern),
  pack: z.string().regex(packNamePattern),
  version: z.string().regex(semverPattern),
  endpointEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  defaultEndpoint: z.url(),
  inputMapping: z.record(z.string(), sourceBindingSchema),
  timeoutMs: z.number().int().positive().max(300_000),
}).strict()

const compositionVerificationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subset-of-child'),
    outputPath: z.string().startsWith('/'),
    childId: z.string().regex(identifierPattern),
    childPath: z.string().startsWith('/'),
  }).strict(),
  z.object({
    type: z.literal('covers-child'),
    outputPath: z.string().startsWith('/'),
    outputKeyPath: z.string().startsWith('/'),
    childId: z.string().regex(identifierPattern),
    childPath: z.string().startsWith('/'),
    childKeyPath: z.string().startsWith('/'),
  }).strict(),
])

const invariantSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().regex(identifierPattern),
    type: z.literal('subset'),
    subsetPath: z.string().startsWith('/'),
    supersetPath: z.string().startsWith('/'),
  }).strict(),
  z.object({
    id: z.string().regex(identifierPattern),
    type: z.literal('required-values'),
    path: z.string().startsWith('/'),
    values: z.array(jsonValue).min(1),
  }).strict(),
  z.object({
    id: z.string().regex(identifierPattern),
    type: z.literal('filtered-coverage'),
    sourcePath: z.string().startsWith('/'),
    sourceKeyPath: z.string().startsWith('/'),
    filterPath: z.string().startsWith('/'),
    equals: jsonValue,
    targetPath: z.string().startsWith('/'),
    targetKeyPath: z.string().startsWith('/'),
  }).strict(),
  z.object({
    id: z.string().regex(identifierPattern),
    type: z.literal('filtered-exclusion'),
    sourcePath: z.string().startsWith('/'),
    sourceKeyPath: z.string().startsWith('/'),
    filterPath: z.string().startsWith('/'),
    equals: jsonValue,
    targetPath: z.string().startsWith('/'),
  }).strict(),
])

export const agentPackSchema = z.object({
  apiVersion: z.literal(VERSION_LOCK.packIr),
  kind: z.literal('AgentPack'),
  metadata: z.object({
    name: z.string().regex(packNamePattern),
    version: z.string().regex(semverPattern),
    domain: z.string().regex(identifierPattern),
    displayName: z.string().min(1),
    description: z.string().min(1),
  }).strict(),
  spec: z.object({
    interface: z.object({
      inputSchema: jsonSchema,
      outputSchema: jsonSchema,
    }).strict(),
    prompt: z.object({
      instructions: z.string().min(1),
      outputContract: z.string().min(1),
    }).strict(),
    model: z.object({
      requiredCapabilities: z.array(z.enum(['chat', 'tool-calling', 'json-output'])).min(1),
      maxOutputTokens: z.number().int().positive().max(65_536),
    }).strict(),
    tools: z.object({
      mcp: z.array(z.object({
        id: z.string().regex(identifierPattern),
        server: z.enum(['wardrobe', 'parenting', 'travel']),
        transport: z.literal('stdio'),
        allow: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1),
        required: z.boolean(),
        timeoutMs: z.number().int().positive().max(300_000),
      }).strict()).max(3),
    }).strict(),
    composition: z.object({
      children: z.array(childSchema),
      verify: z.array(compositionVerificationSchema),
    }).strict(),
    policy: z.object({
      readonlyTools: z.literal(true),
      network: z.literal('deny-by-default'),
      failureMode: z.literal('closed'),
      taskTimeoutMs: z.number().int().positive().max(600_000),
      maxParallelTools: z.number().int().positive().max(8),
    }).strict(),
    memory: z.object({
      scope: z.enum(['task', 'session']),
      persistence: z.enum(['none', 'runtime']),
    }).strict(),
    eval: z.object({
      invariants: z.array(invariantSchema),
      requiredTraceEvents: z.array(z.string().min(1)).min(1),
      cases: z.array(z.object({
        id: z.string().regex(identifierPattern),
        input: jsonSchema,
        expected: z.object({
          requiredToolCalls: z.array(z.string()),
          requiredChildAgents: z.array(z.string()),
        }).strict(),
      }).strict()).min(1),
    }).strict(),
  }).strict(),
}).strict()

export type AgentPack = z.infer<typeof agentPackSchema>
export type ChildAgentSpec = AgentPack['spec']['composition']['children'][number]
export type PackInvariant = AgentPack['spec']['eval']['invariants'][number]
export type CompositionVerification = AgentPack['spec']['composition']['verify'][number]

const mcpCatalog: Readonly<Record<string, ReadonlySet<string>>> = {
  wardrobe: new Set(['list_candidates', 'get_item_details']),
  parenting: new Set(['list_applicable_rules', 'get_rule_details']),
  travel: new Set(['get_destination_facts', 'get_activity_facts']),
}

export async function loadAgentPack(path: string): Promise<AgentPack> {
  const absolutePath = resolve(path)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(absolutePath, 'utf8'))
  } catch (cause) {
    throw new AgentPackError('PACK_INVALID', `Cannot read Agent Pack: ${absolutePath}`, undefined, { cause })
  }
  const result = agentPackSchema.safeParse(raw)
  if (!result.success) {
    throw new AgentPackError('PACK_INVALID', `Agent Pack schema validation failed: ${absolutePath}`, result.error.issues)
  }
  validateCrossReferences(result.data)
  return result.data
}

export function validateCrossReferences(pack: AgentPack): void {
  const toolIds = new Set<string>()
  for (const tool of pack.spec.tools.mcp) {
    if (toolIds.has(tool.id)) throw new AgentPackError('PACK_INVALID', `Duplicate MCP binding id: ${tool.id}`)
    toolIds.add(tool.id)
    const knownTools = mcpCatalog[tool.server]
    const unknown = tool.allow.filter(name => !knownTools?.has(name))
    if (unknown.length > 0) {
      throw new AgentPackError('PACK_INVALID', `Unknown ${tool.server} MCP tools: ${unknown.join(', ')}`)
    }
  }

  const children = new Map(pack.spec.composition.children.map(child => [child.id, child]))
  if (children.size !== pack.spec.composition.children.length) {
    throw new AgentPackError('PACK_INVALID', 'Composition child ids must be unique')
  }
  for (const verification of pack.spec.composition.verify) {
    if (!children.has(verification.childId)) {
      throw new AgentPackError('PACK_INVALID', `Composition verification references missing child: ${verification.childId}`)
    }
  }
  for (const child of children.values()) {
    if (child.pack === pack.metadata.name && child.version === pack.metadata.version) {
      throw new AgentPackError('PACK_INVALID', 'A Pack cannot compose itself at the same version')
    }
  }
}

export function packIdentity(pack: AgentPack): string {
  return `${pack.metadata.name}@${pack.metadata.version}`
}

export function packDigest(pack: AgentPack): string {
  return `sha256:${sha256(pack)}`
}
