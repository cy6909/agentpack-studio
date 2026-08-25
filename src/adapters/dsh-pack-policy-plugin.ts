interface ToolResult {
  isError: boolean
}

interface ScopedToolRegistry {
  restrict(filter: { deny: string[] }): () => void
}

interface AgentHandle {
  ctx: {
    tools: ScopedToolRegistry
  }
}

interface ToolExecution {
  name: string
  agent?: AgentHandle
}

interface PolicyContext {
  on(event: 'tools/result', listener: (execution: ToolExecution, result: ToolResult) => void): unknown
  effect(callback: () => () => void, label?: string): unknown
}

interface PolicyConfig {
  requiredTools: string[]
}

/** Cordis plugin name used by generated DSH compositions. */
export const name = 'agentpack-pack-policy'

/** Tool result events and scoped restrictions are both owned by ToolRuntime. */
export const inject = ['tools']

/**
 * Turn a required-tool Pack into two explicit phases for runtimes whose model
 * adapter otherwise keeps advertising tools forever:
 *
 * 1. expose the Pack's required tools until each has one successful result;
 * 2. hide those tools from that exact Agent scope so its next model request
 *    must produce the structured final answer.
 *
 * Tool-order validation remains valid because DSH restrictions hide schemas
 * while retaining the names as known capabilities. Failed calls never advance
 * the gate, so error, malformed-data and cancellation paths remain fail-closed.
 */
export function apply(ctx: PolicyContext, config: PolicyConfig): void {
  if (config.requiredTools.length === 0) return
  const required = new Set(config.requiredTools)
  const successful = new WeakMap<AgentHandle, Set<string>>()
  const gated = new WeakSet<AgentHandle>()
  const restrictions = new Set<() => void>()

  ctx.on('tools/result', (execution, result) => {
    const agent = execution.agent
    if (!agent || gated.has(agent) || result.isError || !required.has(execution.name)) return
    const completed = successful.get(agent) ?? new Set<string>()
    completed.add(execution.name)
    successful.set(agent, completed)
    if (![...required].every(tool => completed.has(tool))) return

    const dispose = agent.ctx.tools.restrict({ deny: [...required] })
    restrictions.add(dispose)
    gated.add(agent)
  })

  ctx.effect(() => () => {
    for (const dispose of restrictions) dispose()
    restrictions.clear()
  }, 'agentpack-pack-policy')
}
