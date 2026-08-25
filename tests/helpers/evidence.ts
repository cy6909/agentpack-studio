import { readFile } from 'node:fs/promises'

export async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

export async function waitForJsonLine(
  path: string,
  predicate: (record: Record<string, unknown>) => boolean,
  timeoutMs = 180_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const match = (await readJsonLines(path)).find(predicate)
      if (match) return match
    } catch {
      // The producer may not have created the file yet.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`Timed out waiting for JSONL evidence: ${path}`)
}
