import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { A2aClient } from '../../src/adapters/a2a-client.js'
import { startA2aServer, type A2aServerHandle } from '../../src/adapters/a2a-server.js'
import { DshCompiler, type DshCompiledArtifact } from '../../src/adapters/dsh-compiler.js'
import { AgentPackError } from '../../src/core/errors.js'
import type { JsonObject } from '../../src/core/json.js'
import { PackExecutor } from '../../src/core/pack-executor.js'
import type { AgentRuntime, RuntimeInvocation, RuntimeOutputGuard, RuntimeStreamEvent } from '../../src/core/runtime-port.js'
import { TraceSink } from '../../src/core/trace.js'

let directory: string
let artifact: DshCompiledArtifact
let runtime: FakeRuntime
let server: A2aServerHandle
let endpoint: string

beforeAll(async () => {
  process.env.QWEN_API_KEY = 'remote-test-key'
  directory = await mkdtemp(join(tmpdir(), 'agentpack-a2a-'))
  const compiled = await new DshCompiler().compile({
    packPath: 'packs/stylemuse-wardrobe/pack.json',
    targetPath: 'targets/qwen-dsh.poc.json',
    outputDirectory: join(directory, 'compiled'),
    projectRoot: process.cwd(),
  })
  artifact = { ...compiled, runtime: { ...compiled.runtime, mcpBindings: [] } }
  runtime = new FakeRuntime()
  const port = await freePort()
  endpoint = `http://127.0.0.1:${port}`
  const trace = new TraceSink(join(directory, 'trace.jsonl'))
  server = await startA2aServer({
    artifact,
    executor: new PackExecutor({ artifact, runtime, trace }),
    trace,
    host: '127.0.0.1',
    port,
    publicUrl: endpoint,
  })
})

afterAll(async () => {
  await server.close()
  await runtime.close()
  await rm(directory, { recursive: true, force: true })
})

describe('generic A2A gateway', () => {
  it('publishes task, working events, one structured artifact and a completed terminal state', async () => {
    const kinds: string[] = []
    const result = await new A2aClient().invoke({
      endpoint,
      input: wardrobeInput('success'),
      signal: AbortSignal.timeout(10_000),
      onEvent: event => { kinds.push(String(event.kind)) },
    })
    expect(result.output.recommendationId).toBe('rec-success')
    expect(kinds).toContain('task')
    expect(kinds).toContain('status-update')
    expect(kinds).toContain('artifact-update')
    expect(kinds.at(-1)).toBe('status-update')
  })

  it('fails invalid structured input before invoking the runtime', async () => {
    const callsBefore = runtime.invocations.length
    await expect(new A2aClient().invoke({
      endpoint,
      input: { profileId: 9 } as unknown as JsonObject,
      signal: AbortSignal.timeout(10_000),
    })).rejects.toThrow(/input schema/i)
    expect(runtime.invocations).toHaveLength(callsBefore)
  })

  it('turns runtime and output-schema errors into final failed states', async () => {
    await expect(invoke('runtime-error')).rejects.toThrow(/synthetic runtime failure/)
    await expect(invoke('invalid-output')).rejects.toThrow(/output schema/i)
  })

  it('propagates tasks/cancel to the runtime and emits no late artifact or completion', async () => {
    const observed: JsonObject[] = []
    const task = Promise.withResolvers<string>()
    const stream = consumeRawStream(endpoint, wardrobeInput('hang'), event => {
      observed.push(event)
      const result = event.result
      if (isRecord(result) && result.kind === 'task' && typeof result.id === 'string') task.resolve(result.id)
    })
    const taskId = await task.promise
    await runtime.hangStarted.promise
    await new A2aClient().cancel(endpoint, taskId)
    await stream
    const results = observed.map(event => event.result).filter(isRecord)
    expect(results.some(result => result.kind === 'status-update' && isRecord(result.status) && result.status.state === 'canceled')).toBe(true)
    expect(results.some(result => result.kind === 'artifact-update')).toBe(false)
    expect(results.some(result => result.kind === 'status-update' && isRecord(result.status) && result.status.state === 'completed')).toBe(false)
    expect(runtime.cancelledSessions.length).toBeGreaterThan(0)
  })

  it('keeps concurrent task outputs isolated', async () => {
    const [alpha, beta] = await Promise.all([invoke('alpha'), invoke('beta')])
    expect(alpha.output.recommendationId).toBe('rec-alpha')
    expect(beta.output.recommendationId).toBe('rec-beta')
    expect(alpha.taskId).not.toBe(beta.taskId)
  })

  it('serves a registerable A2A 0.3 agent card', async () => {
    const response = await fetch(`${endpoint}/.well-known/agent-card.json`)
    expect(response.ok).toBe(true)
    const card = await response.json() as Record<string, unknown>
    expect(card.protocolVersion).toBe('0.3.0')
    expect(card.capabilities).toMatchObject({ streaming: true })
  })
})

async function invoke(profileId: string) {
  return new A2aClient().invoke({ endpoint, input: wardrobeInput(profileId), signal: AbortSignal.timeout(10_000) })
}

function wardrobeInput(profileId: string): JsonObject {
  return {
    profileId,
    occasion: 'client-meeting',
    climate: 'mild',
    preferences: { preferredColors: ['navy'], avoidMaterials: [] },
  }
}

class FakeRuntime implements AgentRuntime {
  readonly invocations: RuntimeInvocation[] = []
  readonly cancelledSessions: string[] = []
  readonly hangStarted = Promise.withResolvers<void>()

  start(): Promise<void> { return Promise.resolve() }

  async invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal,
    onEvent: (event: RuntimeStreamEvent) => void | Promise<void>,
    guardOutput: RuntimeOutputGuard,
  ): Promise<JsonObject> {
    this.invocations.push(invocation)
    const sessionId = randomUUID()
    await onEvent({ type: 'runtime.started', sessionId })
    const profileId = String(invocation.input.profileId)
    if (profileId === 'runtime-error') throw new AgentPackError('RUNTIME_FAILED', 'synthetic runtime failure')
    if (profileId === 'invalid-output') return { invalid: true }
    if (profileId === 'hang') {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new AgentPackError('CANCELLED', 'fake runtime cancelled before its wait'))
          return
        }
        signal.addEventListener('abort', () => {
          this.cancelledSessions.push(sessionId)
          reject(new AgentPackError('CANCELLED', 'fake runtime cancelled'))
        }, { once: true })
        this.hangStarted.resolve()
      })
    }
    await new Promise(resolveWait => setTimeout(resolveWait, profileId === 'alpha' ? 20 : 5))
    const output = validOutput(profileId)
    await onEvent({ type: 'runtime.message', sessionId, text: JSON.stringify(output) })
    guardOutput(output)
    await onEvent({ type: 'runtime.completed', sessionId, stopReason: 'end_turn' })
    return output
  }

  cancel(sessionId: string): Promise<void> {
    this.cancelledSessions.push(sessionId)
    return Promise.resolve()
  }

  close(): Promise<void> { return Promise.resolve() }
}

function validOutput(profileId: string): JsonObject {
  return {
    recommendationId: `rec-${profileId}`,
    selectedItemIds: ['w-top-silk-01', 'w-bottom-trouser-01', 'w-shoes-loafer-01'],
    coveredSlots: ['top', 'bottom', 'shoes'],
    outfit: [
      { slot: 'top', itemId: 'w-top-silk-01', reason: 'formal top' },
      { slot: 'bottom', itemId: 'w-bottom-trouser-01', reason: 'formal bottom' },
      { slot: 'shoes', itemId: 'w-shoes-loafer-01', reason: 'smart shoes' },
    ],
    rationale: 'Fixture output for gateway tests.',
    evidence: {
      candidateIds: ['w-top-silk-01', 'w-bottom-trouser-01', 'w-shoes-loafer-01'],
      itemFacts: [
        { id: 'w-top-silk-01', category: 'top', color: 'ivory', warmth: 'light', formality: 'formal', material: 'silk', available: true },
        { id: 'w-bottom-trouser-01', category: 'bottom', color: 'charcoal', warmth: 'medium', formality: 'formal', material: 'wool-blend', available: true },
        { id: 'w-shoes-loafer-01', category: 'shoes', color: 'brown', warmth: 'medium', formality: 'smart', material: 'leather', available: true },
      ],
      sourceVersion: 'wardrobe-fixture@1',
      toolCalls: ['mcp__wardrobe__list_candidates', 'mcp__wardrobe__get_item_details'],
    },
  }
}

async function freePort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((resolveListen, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('Cannot allocate a TCP port')
  await new Promise<void>((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose()))
  return address.port
}

async function consumeRawStream(endpointUrl: string, input: JsonObject, onEvent: (event: JsonObject) => void): Promise<void> {
  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: randomUUID(), method: 'message/stream',
      params: { message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'data', data: input }] } },
    }),
  })
  if (!response.ok || !response.body) throw new Error(`Raw A2A stream failed: ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() ?? ''
    for (const event of events) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
      if (data) {
        const parsed: unknown = JSON.parse(data)
        if (isRecord(parsed)) onEvent(parsed)
      }
    }
    if (done) break
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
