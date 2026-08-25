import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve } from 'node:path'

export interface PackServerProcess {
  child: ChildProcessWithoutNullStreams
  endpoint: string
  stdout: string[]
  stderr: string[]
  stop(): Promise<void>
}

export async function startPackServer(options: {
  packPath: string
  targetPath: string
  port: number
  outputDirectory: string
  environment?: Record<string, string>
  publicUrl?: string
}): Promise<PackServerProcess> {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const endpoint = `http://127.0.0.1:${options.port}`
  const child = spawn(process.execPath, [
    resolve('dist/server-main.js'),
    '--pack', resolve(options.packPath),
    '--target', resolve(options.targetPath),
    '--port', String(options.port),
    '--output', resolve(options.outputDirectory),
    '--public-url', options.publicUrl ?? endpoint,
    '--project-root', process.cwd(),
  ], {
    cwd: process.cwd(),
    env: { ...environment, ...options.environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderr.push(...chunk.split(/\r?\n/).filter(Boolean)))
  const ready = Promise.withResolvers<void>()
  let stdoutBuffer = ''
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines.filter(Boolean)) {
      stdout.push(line)
      try {
        const record = JSON.parse(line) as Record<string, unknown>
        if (record.event === 'agentpack.server.ready') ready.resolve()
      } catch {
        // Keep non-JSON diagnostics in captured stdout for failure reporting.
      }
    }
  })
  child.once('exit', code => ready.reject(new Error(`AgentPack server exited before ready (${code}): ${stderr.join('\n')}`)))
  await Promise.race([
    ready.promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`AgentPack server ready timeout: ${stderr.join('\n')}`)), 120_000)),
  ])
  return {
    child,
    endpoint,
    stdout,
    stderr,
    stop: async () => {
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      await Promise.race([
        new Promise<void>(resolveExit => child.once('exit', () => resolveExit())),
        new Promise<void>(resolveTimeout => setTimeout(() => {
          child.kill('SIGKILL')
          resolveTimeout()
        }, 10_000)),
      ])
    },
  }
}
