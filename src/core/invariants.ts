import { AgentPackError } from './errors.js'
import type { CompositionVerification, PackInvariant } from './pack-ir.js'
import type { ChildInvocationResult } from './runtime-port.js'
import type { JsonObject, JsonValue } from './json.js'
import { readJsonPointer, stableJson } from './json.js'

export function enforcePackInvariants(output: JsonObject, invariants: readonly PackInvariant[]): void {
  for (const invariant of invariants) {
    switch (invariant.type) {
      case 'subset':
        enforceSubset(
          readArray(output, invariant.subsetPath, invariant.id),
          readArray(output, invariant.supersetPath, invariant.id),
          invariant.id,
        )
        break
      case 'required-values':
        enforceRequiredValues(readArray(output, invariant.path, invariant.id), invariant.values, invariant.id)
        break
      case 'filtered-coverage':
        enforceFilteredCoverage(output, invariant)
        break
      case 'filtered-exclusion':
        enforceFilteredExclusion(output, invariant)
        break
    }
  }
}

export function enforceCompositionVerifications(
  output: JsonObject,
  children: Readonly<Record<string, ChildInvocationResult>>,
  verifications: readonly CompositionVerification[],
): void {
  for (const verification of verifications) {
    const child = children[verification.childId]
    if (!child) {
      throw new AgentPackError('POLICY_VIOLATION', `Missing composed child result: ${verification.childId}`)
    }
    switch (verification.type) {
      case 'subset-of-child':
        enforceSubset(
          readArray(output, verification.outputPath, `composition:${verification.childId}`),
          readArray(child.output, verification.childPath, `composition:${verification.childId}`),
          `composition:${verification.childId}`,
        )
        break
      case 'covers-child': {
        const outputRows = readObjectArray(output, verification.outputPath, `composition:${verification.childId}`)
        const childRows = readObjectArray(child.output, verification.childPath, `composition:${verification.childId}`)
        const outputKeys = new Set(outputRows.map(row => stableJson(readJsonPointer(row, verification.outputKeyPath))))
        const missing = childRows
          .map(row => readJsonPointer(row, verification.childKeyPath))
          .filter(key => !outputKeys.has(stableJson(key)))
        if (missing.length > 0) {
          throw new AgentPackError(
            'POLICY_VIOLATION',
            `Composition coverage failed for ${verification.childId}`,
            { missing },
          )
        }
        break
      }
    }
  }
}

function enforceSubset(subset: JsonValue[], superset: JsonValue[], id: string): void {
  const allowed = new Set(superset.map(stableJson))
  const unexpected = subset.filter(value => !allowed.has(stableJson(value)))
  if (unexpected.length > 0) {
    throw new AgentPackError('POLICY_VIOLATION', `Invariant ${id} failed: values are outside the allowed set`, { unexpected })
  }
}

function enforceRequiredValues(actual: JsonValue[], required: JsonValue[], id: string): void {
  const present = new Set(actual.map(stableJson))
  const missing = required.filter(value => !present.has(stableJson(value)))
  if (missing.length > 0) {
    throw new AgentPackError('POLICY_VIOLATION', `Invariant ${id} failed: required values are missing`, { missing })
  }
}

function enforceFilteredCoverage(output: JsonObject, invariant: Extract<PackInvariant, { type: 'filtered-coverage' }>): void {
  const source = readObjectArray(output, invariant.sourcePath, invariant.id)
  const target = readObjectArray(output, invariant.targetPath, invariant.id)
  const targetKeys = new Set(target.map(row => stableJson(readJsonPointer(row, invariant.targetKeyPath))))
  const missing = source
    .filter(row => stableJson(readJsonPointer(row, invariant.filterPath)) === stableJson(invariant.equals))
    .map(row => readJsonPointer(row, invariant.sourceKeyPath))
    .filter(key => !targetKeys.has(stableJson(key)))
  if (missing.length > 0) {
    throw new AgentPackError('POLICY_VIOLATION', `Invariant ${invariant.id} failed: filtered evidence is not covered`, { missing })
  }
}

function enforceFilteredExclusion(output: JsonObject, invariant: Extract<PackInvariant, { type: 'filtered-exclusion' }>): void {
  const source = readObjectArray(output, invariant.sourcePath, invariant.id)
  const target = readArray(output, invariant.targetPath, invariant.id)
  const forbidden = new Set(source
    .filter(row => stableJson(readJsonPointer(row, invariant.filterPath)) === stableJson(invariant.equals))
    .map(row => stableJson(readJsonPointer(row, invariant.sourceKeyPath))))
  const violations = target.filter(value => forbidden.has(stableJson(value)))
  if (violations.length > 0) {
    throw new AgentPackError('POLICY_VIOLATION', `Invariant ${invariant.id} failed: forbidden evidence values were selected`, { violations })
  }
}

function readArray(document: JsonObject, pointer: string, id: string): JsonValue[] {
  const value = readJsonPointer(document, pointer)
  if (!Array.isArray(value)) {
    throw new AgentPackError('POLICY_VIOLATION', `Invariant ${id} expected an array at ${pointer}`)
  }
  return value as JsonValue[]
}

function readObjectArray(document: JsonObject, pointer: string, id: string): JsonObject[] {
  const value = readArray(document, pointer, id)
  if (value.some(row => typeof row !== 'object' || row === null || Array.isArray(row))) {
    throw new AgentPackError('POLICY_VIOLATION', `Invariant ${id} expected object rows at ${pointer}`)
  }
  return value as JsonObject[]
}
