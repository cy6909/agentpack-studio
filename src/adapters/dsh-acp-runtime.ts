import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent as AcpAgent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import { AgentPackError, errorMessage } from '../core/errors.js'
import { parseJsonObject } from '../core/json.js'
import type { AgentRuntime, RuntimeInvocation, RuntimeStreamEvent } from '../core/runtime-port.js'
import type { DshCompiledArtifact } from './dsh-compiler.js'

interface SessionObserver {
  text: string[]
  onEvent: (event: RuntimeStreamEvent) => void | Promise<void>
}

export interface DshAcpRuntimeOptions {
  artifact: DshCompiledArtifact
  cwd: string
  onDiagnostic?: (line: string) => void
}

export class DshAcpRuntime implements AgentRuntime {
  readonly #options: DshAcpRuntimeOptions
  readonly #sessions = new Map<string, SessionObserver>()
  #process?: ChildProcessWithoutNullStreams
  #connection?: ClientSideConnection
  #started = false
  #closed = false

  constructor(options: DshAcpRuntimeOptions) {
    this.#options = options
  }

  async start(): Promise<void> {
    if (this.#started) return
    if (this.#closed) throw new AgentPackError('RUNTIME_START_FAILED', 'DSH ACP runtime is already closed')
    const require = createRequire(import.meta.url)
    const executable = require.resolve('@deepseek-ai/dsh-acp-demo/bin')
    const child = spawn(process.execPath, [executable, '--config', this.#options.artifact.runtime.cordisConfigPath], {
      cwd: this.#options.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#process = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) this.#options.onDiagnostic?.(line)
    })

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ) as Stream
    const connection = new ClientSideConnection(this.#makeClient, stream)
    this.#connection = connection
    try {
      await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    } catch (cause) {
      child.kill('SIGTERM')
      throw new AgentPackError('RUNTIME_START_FAILED', 'DSH ACP initialize failed', undefined, { cause })
    }
    this.#started = true
  }

  async invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal,
    onEvent: (event: RuntimeStreamEvent) => void | Promise<void>,
  ): Promise<ReturnType<typeof parseJsonObject>> {
    await this.start()
    const connection = this.#connection
    if (!connection) throw new AgentPackError('RUNTIME_FAILED', 'DSH ACP connection is unavailable')
    if (signal.aborted) throw new AgentPackError('CANCELLED', 'Task was cancelled before DSH session creation')

    const { sessionId } = await connection.newSession({ cwd: this.#options.cwd, mcpServers: [] })
    const observer: SessionObserver = { text: [], onEvent }
    this.#sessions.set(sessionId, observer)
    await onEvent({ type: 'runtime.started', sessionId })

    const cancel = () => { void connection.cancel({ sessionId }).catch(() => undefined) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const prompt = JSON.stringify({
        task: {
          traceId: invocation.traceId,
          input: invocation.input,
          childResults: invocation.childResults,
        },
      })
      const result = await connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      })
      if (signal.aborted || result.stopReason === 'cancelled') {
        throw new AgentPackError('CANCELLED', 'DSH ACP prompt was cancelled', { sessionId })
      }
      const text = observer.text.join('')
      const output = parseJsonObject(text, 'DSH model response')
      await onEvent({ type: 'runtime.completed', sessionId, stopReason: result.stopReason })
      return output
    } catch (cause) {
      if (cause instanceof AgentPackError) throw cause
      throw new AgentPackError('RUNTIME_FAILED', `DSH ACP prompt failed: ${errorMessage(cause)}`, { sessionId }, { cause })
    } finally {
      signal.removeEventListener('abort', cancel)
      this.#sessions.delete(sessionId)
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#connection?.cancel({ sessionId })
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#sessions.clear()
    const child = this.#process
    if (!child || child.exitCode !== null) return
    child.stdin.end()
    child.kill('SIGTERM')
    await new Promise<void>(resolveClose => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolveClose()
      }, 5_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolveClose()
      })
    })
  }

  readonly #makeClient = (_agent: AcpAgent): Client => ({
    sessionUpdate: async (notification: SessionNotification): Promise<void> => {
      const observer = this.#sessions.get(notification.sessionId)
      if (!observer) return
      const update = notification.update
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        observer.text.push(update.content.text)
        await observer.onEvent({
          type: 'runtime.message',
          sessionId: notification.sessionId,
          text: update.content.text,
        })
      }
    },
    requestPermission: async (_request: RequestPermissionRequest): Promise<RequestPermissionResponse> => ({
      outcome: { outcome: 'cancelled' },
    }),
  })
}
