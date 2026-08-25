import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

interface ReadinessConfig {
  path: string
  requiredTools: string[]
}

interface ToolRegistry {
  get(name: string): unknown
  schemas(): Array<{ name: string }>
}

interface LoaderService {
  await(): Promise<void>
}

interface ReadinessContext {
  loader: LoaderService
  tools: ToolRegistry
  effect(callback: () => () => void, label?: string): unknown
  logger: {
    error(message: string): void
  }
}

interface ReadinessRecord {
  state: 'ready' | 'failed'
  requiredTools: string[]
  knownTools: string[]
  missingTools: string[]
  observedAt: string
  pid: number
  error?: string
}

/** Cordis plugin name used by generated DSH compositions. */
export const name = 'agentpack-runtime-readiness'

/** The barrier needs both the Loader settlement primitive and the DSH tool registry. */
export const inject = ['loader', 'tools']

/**
 * Publish a cross-process readiness proof only after every loader entry has
 * settled. This closes the gap between ACP initialize (one plugin is active)
 * and the whole DSH composition being ready (MCP tools are registered).
 */
export function apply(ctx: ReadinessContext, config: ReadinessConfig): void {
  let active = true
  ctx.effect(() => () => { active = false }, 'agentpack-runtime-readiness')

  void Promise.resolve()
    .then(() => ctx.loader.await())
    .then(async () => {
      if (!active) return
      const knownTools = ctx.tools.schemas().map(schema => schema.name).sort()
      const missingTools = config.requiredTools.filter(tool => ctx.tools.get(tool) === undefined)
      await publish(config.path, {
        state: missingTools.length === 0 ? 'ready' : 'failed',
        requiredTools: [...config.requiredTools],
        knownTools,
        missingTools,
        observedAt: new Date().toISOString(),
        pid: process.pid,
        ...(missingTools.length === 0 ? {} : { error: `Required DSH tools are unavailable: ${missingTools.join(', ')}` }),
      })
    })
    .catch(async (cause: unknown) => {
      if (!active) return
      const error = cause instanceof Error ? cause.message : String(cause)
      try {
        await publish(config.path, {
          state: 'failed',
          requiredTools: [...config.requiredTools],
          knownTools: [],
          missingTools: [...config.requiredTools],
          observedAt: new Date().toISOString(),
          pid: process.pid,
          error: `Cordis loader settlement failed: ${error}`,
        })
      } catch (publishError: unknown) {
        ctx.logger.error(`agentpack readiness proof failed: ${String(publishError)}`)
      }
    })
}

async function publish(path: string, record: ReadinessRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, 'utf8')
  await rename(temporaryPath, path)
}
