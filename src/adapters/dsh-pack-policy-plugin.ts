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
  maxAttemptsPerTool?: number
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
 * 2. hide each successful tool so the model can only select a missing one;
 * 3. allow one bounded correction after a failed call (including argument
 *    validation before MCP dispatch), then hide the whole required set so the
 *    turn converges and the Pack executor can reject missing success evidence;
 * 4. once no tools remain, the next request is the structured-output phase.
 *
 * Tool-order validation remains valid because DSH restrictions hide schemas
 * while retaining the names as known capabilities. Error, malformed-data and
 * cancellation paths remain fail-closed because only successful audit records
 * satisfy the outer Pack executor.
 */
export function apply(ctx: PolicyContext, config: PolicyConfig): void {
  if (config.requiredTools.length === 0) return
  const maxAttemptsPerTool = config.maxAttemptsPerTool ?? 2
  if (!Number.isSafeInteger(maxAttemptsPerTool) || maxAttemptsPerTool < 1) {
    throw new Error('agentpack-pack-policy maxAttemptsPerTool must be a positive integer')
  }
  const required = new Set(config.requiredTools)
  const successful = new WeakMap<AgentHandle, Set<string>>()
  const attempts = new WeakMap<AgentHandle, Map<string, number>>()
  const restrictions = new Set<() => void>()

  ctx.on('tools/result', (execution, result) => {
    const agent = execution.agent
    if (!agent || !required.has(execution.name)) return
    const counts = attempts.get(agent) ?? new Map<string, number>()
    const count = (counts.get(execution.name) ?? 0) + 1
    counts.set(execution.name, count)
    attempts.set(agent, counts)
    if (result.isError) {
      if (count < maxAttemptsPerTool) return
      const dispose = agent.ctx.tools.restrict({ deny: [...required] })
      restrictions.add(dispose)
      return
    }
    const completed = successful.get(agent) ?? new Set<string>()
    if (completed.has(execution.name)) return
    completed.add(execution.name)
    successful.set(agent, completed)

    // Hide each successfully completed tool immediately. With a transport
    // policy of "required while tools are advertised", the model can only
    // choose from the still-missing requirements on the next step. Once the
    // last requirement succeeds, no tools remain and the following request is
    // the structured-output phase.
    const dispose = agent.ctx.tools.restrict({ deny: [execution.name] })
    restrictions.add(dispose)
  })

  ctx.effect(() => () => {
    for (const dispose of restrictions) dispose()
    restrictions.clear()
  }, 'agentpack-pack-policy')
}
