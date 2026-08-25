import type { JsonObject } from './json.js'

export interface RuntimeStreamEvent {
  type: 'runtime.started' | 'runtime.message' | 'runtime.recovering' | 'runtime.completed'
  sessionId: string
  text?: string
  stopReason?: string
  attempt?: number
}

export interface RuntimeInvocation {
  input: JsonObject
  traceId: string
  childResults: Readonly<Record<string, ChildInvocationResult>>
}

export interface ChildInvocationResult {
  childId: string
  pack: string
  version: string
  taskId: string
  route: 'direct' | 'agentstack-proxy'
  outputDigest: string
  output: JsonObject
}

export interface AgentRuntime {
  start(): Promise<void>
  invoke(
    invocation: RuntimeInvocation,
    signal: AbortSignal,
    onEvent: (event: RuntimeStreamEvent) => void | Promise<void>,
  ): Promise<JsonObject>
  cancel(sessionId: string): Promise<void>
  close(): Promise<void>
}

export interface RuntimeCompiler<TArtifact> {
  compile(options: { packPath: string; targetPath: string; outputDirectory: string }): Promise<TArtifact>
}
