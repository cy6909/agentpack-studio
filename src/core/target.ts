import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { AgentPackError } from './errors.js'

export const compilationTargetSchema = z.object({
  apiVersion: z.literal('agentpack.studio/target/v1alpha1'),
  kind: z.literal('CompilationTarget'),
  metadata: z.object({
    name: z.string().min(1),
  }).strict(),
  spec: z.object({
    runtime: z.object({
      adapter: z.literal('dsh-acp'),
      provider: z.string().min(1),
      model: z.string().min(1),
      baseUrl: z.url(),
      apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      contextWindow: z.number().int().positive(),
      maxTokens: z.number().int().positive(),
      timeoutMs: z.number().int().positive().max(600_000),
      streamIdleTimeoutMs: z.number().int().positive().max(600_000),
      enableThinking: z.boolean(),
    }).strict(),
    transport: z.object({
      host: z.string().min(1),
      publicBaseUrl: z.url(),
    }).strict(),
    composition: z.object({
      route: z.enum(['direct', 'agentstack-proxy']),
      endpoints: z.record(z.string(), z.url()),
      bearerTokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    }).strict(),
  }).strict(),
}).strict()

export type CompilationTarget = z.infer<typeof compilationTargetSchema>

export async function loadCompilationTarget(path: string): Promise<CompilationTarget> {
  const absolutePath = resolve(path)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(absolutePath, 'utf8'))
  } catch (cause) {
    throw new AgentPackError('COMPILE_FAILED', `Cannot read compilation target: ${absolutePath}`, undefined, { cause })
  }
  const result = compilationTargetSchema.safeParse(raw)
  if (!result.success) {
    throw new AgentPackError('COMPILE_FAILED', `Compilation target validation failed: ${absolutePath}`, result.error.issues)
  }
  return result.data
}
