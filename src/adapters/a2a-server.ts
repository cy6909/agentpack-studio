import { randomUUID } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import type { AgentCard, Message, Task } from '@a2a-js/sdk'
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server'
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express'
import express from 'express'
import { AgentPackError, errorMessage } from '../core/errors.js'
import { isJsonObject, type JsonObject } from '../core/json.js'
import type { PackExecutor, PackProgress } from '../core/pack-executor.js'
import type { TraceSink } from '../core/trace.js'
import { VERSION_LOCK } from '../version-lock.js'
import type { DshCompiledArtifact } from './dsh-compiler.js'

interface ActiveTask {
  controller: AbortController
  eventBus: ExecutionEventBus
  contextId: string
  terminalPublished: boolean
}

export interface A2aServerOptions {
  artifact: DshCompiledArtifact
  executor: PackExecutor
  trace: TraceSink
  host: string
  port: number
  publicUrl: string
}

export interface A2aServerHandle {
  url: string
  close(): Promise<void>
}

export async function startA2aServer(options: A2aServerOptions): Promise<A2aServerHandle> {
  const card: AgentCard = {
    name: options.artifact.pack.metadata.displayName,
    description: options.artifact.pack.metadata.description,
    url: options.publicUrl,
    version: options.artifact.pack.metadata.version,
    protocolVersion: VERSION_LOCK.protocols.a2a,
    capabilities: { streaming: true },
    defaultInputModes: ['application/json', 'text'],
    defaultOutputModes: ['application/json', 'text'],
    skills: [],
  }
  const taskStore = new InMemoryTaskStore()
  const agentExecutor = new PackAgentExecutor(options.executor, options.artifact, options.trace)
  const requestHandler = new DefaultRequestHandler(card, taskStore, agentExecutor)
  const app = express()
  app.get('/healthz', (_request, response) => {
    response.json({
      status: 'ok',
      pack: options.artifact.packIdentity,
      packDigest: options.artifact.packDigest,
      runtime: options.artifact.runtime.adapter,
    })
  })
  app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }))
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: requestHandler }))

  const server = await listen(app, options.host, options.port)
  return {
    url: options.publicUrl,
    close: async () => {
      agentExecutor.cancelAll()
      await new Promise<void>((resolveClose, reject) => {
        server.close(error => error ? reject(error) : resolveClose())
      })
      await options.trace.flush()
    },
  }
}

class PackAgentExecutor implements AgentExecutor {
  readonly #executor: PackExecutor
  readonly #artifact: DshCompiledArtifact
  readonly #trace: TraceSink
  readonly #active = new Map<string, ActiveTask>()

  constructor(executor: PackExecutor, artifact: DshCompiledArtifact, trace: TraceSink) {
    this.#executor = executor
    this.#artifact = artifact
    this.#trace = trace
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const task = this.#ensureTask(requestContext, eventBus)
    const active: ActiveTask = {
      controller: new AbortController(),
      eventBus,
      contextId: requestContext.contextId,
      terminalPublished: false,
    }
    this.#active.set(task.id, active)
    const traceId = randomUUID()
    try {
      const input = extractStructuredInput(requestContext.userMessage)
      this.#publishWorking(active, task.id, { phase: 'accepted', traceId })
      const output = await this.#executor.execute({
        taskId: task.id,
        input,
        traceId,
        signal: active.controller.signal,
        onProgress: progress => this.#publishWorking(active, task.id, progress),
      })
      if (active.controller.signal.aborted || active.terminalPublished) return
      eventBus.publish({
        kind: 'artifact-update',
        taskId: task.id,
        contextId: active.contextId,
        artifact: {
          artifactId: randomUUID(),
          name: `${this.#artifact.pack.metadata.name}-output`,
          description: `Validated output from ${this.#artifact.packIdentity}`,
          parts: [{ kind: 'data', data: output }],
          metadata: {
            traceId,
            pack: this.#artifact.pack.metadata.name,
            version: this.#artifact.pack.metadata.version,
            packDigest: this.#artifact.packDigest,
          },
        },
        append: false,
        lastChunk: true,
      })
      if (active.controller.signal.aborted || active.terminalPublished) return
      this.#publishTerminal(active, task.id, 'completed')
      await this.#trace.write({
        event: 'gateway.task.completed',
        traceId,
        taskId: task.id,
        pack: this.#artifact.packIdentity,
      })
    } catch (error) {
      if (active.terminalPublished) return
      if (active.controller.signal.aborted || (error instanceof AgentPackError && error.code === 'CANCELLED')) {
        this.#publishTerminal(active, task.id, 'canceled')
      } else {
        this.#publishTerminal(active, task.id, 'failed', error)
      }
    } finally {
      this.#active.delete(task.id)
      eventBus.finished()
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    const active = this.#active.get(taskId)
    if (!active || active.terminalPublished) return
    active.controller.abort(new AgentPackError('CANCELLED', 'A2A tasks/cancel requested'))
    this.#publishTerminal(active, taskId, 'canceled')
  }

  cancelAll(): void {
    for (const [taskId, active] of this.#active) {
      active.controller.abort(new AgentPackError('CANCELLED', 'A2A server is shutting down'))
      this.#publishTerminal(active, taskId, 'canceled')
    }
  }

  #ensureTask(requestContext: RequestContext, eventBus: ExecutionEventBus): Task {
    if (requestContext.task) return requestContext.task
    const task: Task = {
      kind: 'task',
      id: requestContext.taskId,
      contextId: requestContext.contextId,
      status: { state: 'submitted', timestamp: new Date().toISOString() },
      history: [],
    }
    eventBus.publish(task)
    eventBus.publish({
      kind: 'status-update',
      taskId: task.id,
      contextId: task.contextId,
      status: { state: 'working', timestamp: new Date().toISOString() },
      final: false,
    })
    return task
  }

  #publishWorking(active: ActiveTask, taskId: string, progress: PackProgress): void {
    if (active.controller.signal.aborted || active.terminalPublished) return
    active.eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId: active.contextId,
      status: {
        state: 'working',
        timestamp: new Date().toISOString(),
        message: {
          kind: 'message',
          messageId: randomUUID(),
          role: 'agent',
          taskId,
          contextId: active.contextId,
          parts: [{ kind: 'data', data: progress }],
        },
      },
      final: false,
    })
  }

  #publishTerminal(active: ActiveTask, taskId: string, state: 'completed' | 'failed' | 'canceled', error?: unknown): void {
    if (active.terminalPublished) return
    active.terminalPublished = true
    const code = error instanceof AgentPackError ? error.code : 'UNEXPECTED_ERROR'
    active.eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId: active.contextId,
      status: {
        state,
        timestamp: new Date().toISOString(),
        ...(error === undefined ? {} : {
          message: {
            kind: 'message',
            messageId: randomUUID(),
            role: 'agent',
            taskId,
            contextId: active.contextId,
            parts: [
              { kind: 'text', text: errorMessage(error) },
              { kind: 'data', data: { code, retryable: false } },
            ],
          },
        }),
      },
      final: true,
    })
  }
}

function extractStructuredInput(message: Message): JsonObject {
  for (const part of message.parts) {
    if (part.kind === 'data' && isJsonObject(part.data)) return part.data
    if (part.kind === 'text') {
      try {
        const parsed: unknown = JSON.parse(part.text)
        if (isJsonObject(parsed)) return parsed
      } catch {
        continue
      }
    }
  }
  throw new AgentPackError('INPUT_INVALID', 'A2A message must contain a JSON object DataPart or JSON TextPart')
}

async function listen(app: express.Express, host: string, port: number): Promise<HttpServer> {
  return new Promise((resolveListen, reject) => {
    const server = app.listen(port, host, () => resolveListen(server))
    server.once('error', reject)
  })
}
