import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { A2aClient } from '../../src/adapters/a2a-client.js'
import type { JsonObject } from '../../src/core/json.js'
import { openRawA2aStream } from '../helpers/a2a-stream.js'

const wardrobeUrl = requiredEnvironment('AGENTSTACK_WARDROBE_URL')
const parentingUrl = requiredEnvironment('AGENTSTACK_PARENTING_URL')
const familyUrl = requiredEnvironment('AGENTSTACK_FAMILY_URL')
const token = requiredEnvironment('AGENTSTACK_TOKEN')

describe('Agent Stack v0.7.1 registration and proxy', () => {
  it('requires authentication and rewrites registered cards to Agent Stack proxy routes', async () => {
    if (process.env.AGENTSTACK_AUTH_REQUIRED !== '1') {
      throw new Error('AGENTSTACK_AUTH_REQUIRED=1 is mandatory for a full authentication verdict')
    }
    for (const endpoint of [wardrobeUrl, parentingUrl, familyUrl]) {
      const cardUrl = `${endpoint.replace(/\/$/, '')}/.well-known/agent-card.json`
      const unauthenticated = await fetch(cardUrl)
      expect([401, 403]).toContain(unauthenticated.status)
      const authenticated = await fetch(cardUrl, { headers: { authorization: `Bearer ${token}` } })
      expect(authenticated.ok).toBe(true)
      const card = await authenticated.json() as Record<string, unknown>
      expect(card.protocolVersion).toBe('0.3.0')
      expect(String(card.url)).toContain('/api/v1/a2a/')
    }
  })

  it('routes independent Wardrobe and Parenting calls through authenticated proxies', async () => {
    const wardrobe = await invoke(wardrobeUrl, 'tests/fixtures/wardrobe-input.json')
    expect((wardrobe.output.evidence as JsonObject).sourceVersion).toBe('wardrobe-fixture@1')
    const parenting = await invoke(parentingUrl, 'tests/fixtures/parenting-input.json')
    expect((parenting.output.evidence as JsonObject).sourceVersion).toBe('parenting-rules@1')
  }, 360_000)

  it('composes both child calls through Agent Stack and records proxy provenance', async () => {
    const result = await invoke(familyUrl, 'tests/fixtures/family-trip-input.json')
    const provenance = result.output.provenance as JsonObject
    const children = provenance.childAgents as JsonObject[]
    expect(children.map(child => child.childId).sort()).toEqual(['parenting', 'wardrobe'])
    expect(children.every(child => child.route === 'agentstack-proxy')).toBe(true)
    expect(children.every(child => typeof child.taskId === 'string')).toBe(true)
    expect(children.every(child => /^sha256:[0-9a-f]{64}$/.test(String(child.outputDigest)))).toBe(true)
  }, 600_000)

  it('forwards tasks/cancel through Agent Stack without a late completed event', async () => {
    const input = JSON.parse(await readFile('tests/fixtures/wardrobe-input.json', 'utf8')) as JsonObject
    const stream = openRawA2aStream(wardrobeUrl, input, token)
    const taskId = await stream.taskId
    await new A2aClient().cancel(wardrobeUrl, taskId, token)
    await stream.completed
    const results = stream.events.map(event => event.result).filter(isRecord)
    expect(results.some(result => result.kind === 'status-update' && isRecord(result.status) && result.status.state === 'canceled')).toBe(true)
    expect(results.some(result => result.kind === 'artifact-update')).toBe(false)
    expect(results.some(result => result.kind === 'status-update' && isRecord(result.status) && result.status.state === 'completed')).toBe(false)
  }, 180_000)
})

async function invoke(endpoint: string, path: string) {
  const input = JSON.parse(await readFile(path, 'utf8')) as JsonObject
  return new A2aClient().invoke({
    endpoint,
    input,
    bearerToken: token,
    signal: AbortSignal.timeout(300_000),
  })
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for Agent Stack real tests`)
  return value
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
