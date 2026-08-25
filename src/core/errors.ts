export type AgentPackErrorCode =
  | 'PACK_INVALID'
  | 'INPUT_INVALID'
  | 'COMPILE_FAILED'
  | 'RUNTIME_START_FAILED'
  | 'RUNTIME_FAILED'
  | 'OUTPUT_INVALID'
  | 'POLICY_VIOLATION'
  | 'CHILD_AGENT_FAILED'
  | 'CANCELLED'

export class AgentPackError extends Error {
  readonly code: AgentPackErrorCode
  readonly details?: unknown

  constructor(code: AgentPackErrorCode, message: string, details?: unknown, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgentPackError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
