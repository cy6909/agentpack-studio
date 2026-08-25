import { describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/adapters/dsh-pack-policy-plugin.js'

interface ToolResultListener {
  (
    execution: { name: string; agent?: { ctx: { tools: { restrict: (filter: { deny: string[] }) => () => void } } } },
    result: { isError: boolean },
  ): void
}

describe('DSH Pack tool phase policy', () => {
  it('removes successful tools one at a time', () => {
    const { listener, denied } = policyHarness(['read_index', 'read_details'])

    listener.execution('read_index', false)
    listener.execution('read_details', false)

    expect(denied).toEqual([['read_index'], ['read_details']])
  })

  it('allows one correction and then removes every required tool after a repeated failure', () => {
    const { listener, denied } = policyHarness(['read_index', 'read_details'])

    listener.execution('read_index', true)
    expect(denied).toEqual([])
    listener.execution('read_index', true)

    expect(denied).toEqual([['read_index', 'read_details']])
  })
})

function policyHarness(requiredTools: string[]): {
  listener: { execution: (name: string, isError: boolean) => void }
  denied: string[][]
} {
  let resultListener: ToolResultListener | undefined
  const denied: string[][] = []
  const dispose = vi.fn()
  const agent = {
    ctx: {
      tools: {
        restrict(filter: { deny: string[] }): () => void {
          denied.push(filter.deny)
          return dispose
        },
      },
    },
  }
  apply({
    on(_event, listener) {
      resultListener = listener
    },
    effect(callback) {
      callback()
      return undefined
    },
  }, { requiredTools })
  return {
    denied,
    listener: {
      execution(name, isError) {
        if (!resultListener) throw new Error('policy listener was not installed')
        resultListener({ name, agent }, { isError })
      },
    },
  }
}
