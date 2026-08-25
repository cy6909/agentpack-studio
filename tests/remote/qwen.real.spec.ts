import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { A2aClient } from '../../src/adapters/a2a-client.js'
import type { JsonObject } from '../../src/core/json.js'
import { openRawA2aStream } from '../helpers/a2a-stream.js'
import { readJsonLines, waitForJsonLine } from '../helpers/evidence.js'
import { startPackServer, type PackServerProcess } from '../helpers/remote-process.js'

let directory: string
let wardrobe: PackServerProcess
let parenting: PackServerProcess
let family: PackServerProcess
const processes: PackServerProcess[] = []

beforeAll(async () => {
  if (!process.env.QWEN_API_KEY) throw new Error('QWEN_API_KEY is required for real-model tests')
  directory = resolve(process.env.AGENTPACK_EVIDENCE_ROOT ?? '.agentpack/evidence/qwen-real')
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  wardrobe = await start('wardrobe', 'packs/stylemuse-wardrobe/pack.json', 8201, {
    AGENTPACK_WARDROBE_MCP_AUDIT_PATH: join(directory, 'wardrobe.audit.jsonl'),
  })
  parenting = await start('parenting', 'packs/parenting-safety/pack.json', 8202, {
    AGENTPACK_PARENTING_MCP_AUDIT_PATH: join(directory, 'parenting.audit.jsonl'),
  })
  family = await start('family', 'packs/family-trip-planner/pack.json', 8203, {
    WARDROBE_AGENT_URL: wardrobe.endpoint,
    PARENTING_AGENT_URL: parenting.endpoint,
    AGENTPACK_TRAVEL_MCP_AUDIT_PATH: join(directory, 'travel.audit.jsonl'),
  })
}, 360_000)

afterAll(async () => {
  await Promise.allSettled(processes.reverse().map(process => process.stop()))
})

describe('real Qwen + DSH technical piercing', () => {
  it('executes Wardrobe and Parenting domain MCP tools and returns validated structured outputs', async () => {
    const wardrobeResult = await call(wardrobe.endpoint, 'tests/fixtures/wardrobe-input.json')
    expect(wardrobeResult.output.selectedItemIds).toBeInstanceOf(Array)
    expect(wardrobeResult.output.evidence).toMatchObject({ sourceVersion: 'wardrobe-fixture@1' })
    const parentingResult = await call(parenting.endpoint, 'tests/fixtures/parenting-input.json')
    expect(parentingResult.output.decision).toBe('conditional')
    const constraints = parentingResult.output.constraints as JsonObject[]
    expect(constraints.map(row => row.ruleId)).toEqual(expect.arrayContaining(['rule-water-arm-reach', 'rule-vehicle-restraint']))

    expectSuccessfulTools(await readJsonLines(join(directory, 'wardrobe.audit.jsonl')), ['list_candidates', 'get_item_details'])
    expectSuccessfulTools(await readJsonLines(join(directory, 'parenting.audit.jsonl')), ['list_applicable_rules', 'get_rule_details'])
    await expectCompleteTrace(join(directory, 'wardrobe', 'trace.jsonl'))
  }, 360_000)

  it('composes two leaf agents plus Travel MCP and preserves exact child task provenance', async () => {
    const result = await call(family.endpoint, 'tests/fixtures/family-trip-input.json')
    const provenance = result.output.provenance as JsonObject
    const children = provenance.childAgents as JsonObject[]
    expect(children.map(child => child.childId).sort()).toEqual(['parenting', 'wardrobe'])
    expect(children.every(child => child.route === 'direct')).toBe(true)
    expect(children.every(child => typeof child.taskId === 'string' && String(child.taskId).length > 0)).toBe(true)
    expectSuccessfulTools(await readJsonLines(join(directory, 'travel.audit.jsonl')), ['get_destination_facts', 'get_activity_facts'])
  }, 360_000)

  it('rejects invalid structured input before any model or MCP call', async () => {
    await expect(new A2aClient().invoke({
      endpoint: wardrobe.endpoint,
      input: { profileId: 'p-aria' },
      signal: AbortSignal.timeout(30_000),
    })).rejects.toThrow(/input schema/i)
  })

  it('fails closed for MCP error, business 404 and malformed structured content', async () => {
    const modes = ['error', 'not-found', 'malformed'] as const
    for (let index = 0; index < modes.length; index += 1) {
      const mode = modes[index]!
      const auditPath = join(directory, `wardrobe-${mode}.audit.jsonl`)
      const server = await start(`wardrobe-${mode}`, 'packs/stylemuse-wardrobe/pack.json', 8210 + index, {
        AGENTPACK_WARDROBE_MCP_AUDIT_PATH: auditPath,
        AGENTPACK_WARDROBE_MCP_TEST_MODE: mode,
      })
      await expect(call(server.endpoint, 'tests/fixtures/wardrobe-input.json')).rejects.toThrow()
      const records = await readJsonLines(auditPath)
      expect(records.some(record => record.mode === mode)).toBe(true)
      expect(records.some(record => record.outcome === 'ok')).toBe(false)
      await server.stop()
    }
  }, 600_000)

  it('propagates A2A cancellation through ACP into an in-flight MCP request with no late final result', async () => {
    const auditPath = join(directory, 'wardrobe-timeout.audit.jsonl')
    const server = await start('wardrobe-timeout', 'packs/stylemuse-wardrobe/pack.json', 8220, {
      AGENTPACK_WARDROBE_MCP_AUDIT_PATH: auditPath,
      AGENTPACK_WARDROBE_MCP_TEST_MODE: 'timeout',
    })
    const input = JSON.parse(await readFile('tests/fixtures/wardrobe-input.json', 'utf8')) as JsonObject
    const stream = openRawA2aStream(server.endpoint, input)
    const taskId = await stream.taskId
    await waitForJsonLine(auditPath, record => record.event === 'mcp.tool.started', 240_000)
    await new A2aClient().cancel(server.endpoint, taskId)
    await stream.completed
    await waitForJsonLine(auditPath, record => record.event === 'mcp.tool.cancelled', 30_000)
    const results = stream.events.map(event => event.result).filter(isRecord)
    expect(results.some(result => result.kind === 'artifact-update')).toBe(false)
    expect(results.some(result => result.kind === 'status-update' && isRecord(result.status) && result.status.state === 'completed')).toBe(false)
    expect(results.some(result => result.kind === 'status-update' && isRecord(result.status) && result.status.state === 'canceled')).toBe(true)
    await server.stop()
  }, 360_000)

  it('isolates two concurrent real-model sessions and their MCP traces', async () => {
    const clientMeeting = JSON.parse(await readFile('tests/fixtures/wardrobe-input.json', 'utf8')) as JsonObject
    const familyTrip: JsonObject = {
      ...clientMeeting,
      occasion: 'family-trip',
      climate: 'warm',
      preferences: { preferredColors: ['white'], avoidMaterials: [] },
    }
    const [first, second] = await Promise.all([
      new A2aClient().invoke({ endpoint: wardrobe.endpoint, input: clientMeeting, signal: AbortSignal.timeout(300_000) }),
      new A2aClient().invoke({ endpoint: wardrobe.endpoint, input: familyTrip, signal: AbortSignal.timeout(300_000) }),
    ])
    expect(first.taskId).not.toBe(second.taskId)
    const firstCandidates = (first.output.evidence as JsonObject).candidateIds as string[]
    const secondCandidates = (second.output.evidence as JsonObject).candidateIds as string[]
    expect(firstCandidates).toContain('w-bottom-trouser-01')
    expect(secondCandidates).toContain('w-bottom-denim-02')
    const records = await readJsonLines(join(directory, 'wardrobe.audit.jsonl'))
    const successfulByTrace = new Map<string, Array<Record<string, unknown>>>()
    for (const record of records.filter(candidate => candidate.outcome === 'ok')) {
      const traceId = String(record.traceId)
      successfulByTrace.set(traceId, [...(successfulByTrace.get(traceId) ?? []), record])
    }
    expect([...successfulByTrace.values()].filter(group => new Set(group.map(record => record.tool)).size === 2).length).toBeGreaterThanOrEqual(2)
  }, 600_000)

  it('surfaces a real model transport failure as a failed A2A task', async () => {
    const target = JSON.parse(await readFile('targets/qwen-dsh.poc.json', 'utf8')) as JsonObject
    const spec = target.spec as JsonObject
    const runtime = spec.runtime as JsonObject
    runtime.baseUrl = 'http://127.0.0.1:1/v1'
    const badTargetPath = join(directory, 'bad-model-target.json')
    await writeFile(badTargetPath, `${JSON.stringify(target)}\n`, 'utf8')
    const server = await startPackServer({
      packPath: 'packs/stylemuse-wardrobe/pack.json',
      targetPath: badTargetPath,
      port: 8230,
      outputDirectory: join(directory, 'bad-model'),
    })
    processes.push(server)
    await expect(call(server.endpoint, 'tests/fixtures/wardrobe-input.json')).rejects.toThrow(/failed|turn|transport|fetch/i)
    await server.stop()
  }, 180_000)
})

async function start(name: string, packPath: string, port: number, environment: Record<string, string>) {
  const server = await startPackServer({
    packPath,
    targetPath: 'targets/qwen-dsh.poc.json',
    port,
    outputDirectory: join(directory, name),
    environment,
  })
  processes.push(server)
  return server
}

async function call(endpoint: string, inputPath: string) {
  const input = JSON.parse(await readFile(inputPath, 'utf8')) as JsonObject
  return new A2aClient().invoke({ endpoint, input, signal: AbortSignal.timeout(300_000) })
}

function expectSuccessfulTools(records: Array<Record<string, unknown>>, tools: string[]): void {
  const successful = new Set(records.filter(record => record.outcome === 'ok').map(record => String(record.tool)))
  expect([...successful]).toEqual(expect.arrayContaining(tools))
}

async function expectCompleteTrace(path: string): Promise<void> {
  const records = await readJsonLines(path)
  const required = [
    'gateway.task.accepted',
    'runtime.started',
    'runtime.message',
    'runtime.completed',
    'mcp.tool.completed',
    'gateway.mcp.verified',
    'gateway.output.validated',
    'gateway.task.completed',
  ]
  const byTrace = new Map<string, Set<string>>()
  for (const record of records) {
    const traceId = String(record.traceId)
    const events = byTrace.get(traceId) ?? new Set<string>()
    events.add(String(record.event))
    byTrace.set(traceId, events)
  }
  expect([...byTrace.values()].some(events => required.every(event => events.has(event)))).toBe(true)
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
