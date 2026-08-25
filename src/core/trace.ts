import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { JsonValue } from './json.js'

export interface TraceRecord {
  event: string
  traceId: string
  taskId?: string
  pack?: string
  at?: string
  [key: string]: JsonValue | undefined
}

export class TraceSink {
  readonly #path: string
  #tail: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.#path = path
  }

  write(record: TraceRecord): Promise<void> {
    const complete = { at: new Date().toISOString(), ...record }
    this.#tail = this.#tail.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true })
      await appendFile(this.#path, `${JSON.stringify(complete)}\n`, 'utf8')
    })
    return this.#tail
  }

  flush(): Promise<void> {
    return this.#tail
  }
}
