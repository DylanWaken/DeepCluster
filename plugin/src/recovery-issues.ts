/** Durable diagnostics for isolated recovery failures whose resource ownership remains active. */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

const issueSchema = z.strictObject({ kind: z.enum(['worker-generation', 'operation-record', 'service-launch', 'policy-hook']),
  id: z.string().min(1), message: z.string().min(1), observedAt: z.iso.datetime(), blocksAdmission: z.literal(true).optional() })
const issuesSchema = z.array(issueSchema)

/** A preserved failure that does not revoke unrelated API admission. */
export type RecoveryIssue = z.infer<typeof issueSchema>

/**
 * Validate recovery diagnostics returned across the local HTTP connection.
 * @param value - untrusted health response field.
 * @returns complete validated diagnostics without inventing absent fields.
 */
export function parseRecoveryIssues(value: unknown): readonly RecoveryIssue[] { return issuesSchema.parse(value) }

/**
 * Read the recovery diagnostics retained by the lifecycle controller.
 * @param stateDirectory - exclusively owned API state directory.
 * @returns unresolved diagnostics; absent history is empty.
 */
export async function readRecoveryIssues(stateDirectory: string): Promise<readonly RecoveryIssue[]> {
  try { return issuesSchema.parse(JSON.parse(await readFile(path.join(stateDirectory, 'recovery-issues.json'), 'utf8'))) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Replace one subsystem's diagnostics after its complete recovery scan.
 * The caller holds the API owner lock or the lifecycle lock and admission fence.
 * @param stateDirectory - API state directory.
 * @param kind - subsystem whose scan completed.
 * @param issues - unresolved failures; their resources must remain reserved.
 */
export async function replaceRecoveryIssues(stateDirectory: string, kind: RecoveryIssue['kind'],
  issues: readonly RecoveryIssue[]): Promise<void> {
  const current = await readRecoveryIssues(stateDirectory)
  const next = [...current.filter(issue => issue.kind !== kind), ...issues]
  await mkdir(stateDirectory, { recursive: true })
  const file = path.join(stateDirectory, 'recovery-issues.json')
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(next))
    await handle.sync()
  } finally { await handle.close() }
  try { await rename(temporary, file) } finally {
    try { await unlink(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/**
 * Describe preserved uncertainty without granting permission to release ownership.
 * @param kind - subsystem retaining the failed item.
 * @param id - stable local diagnostic identifier.
 * @param error - observed recovery failure.
 * @returns a timestamped diagnostic for the API health surface.
 */
export function recoveryIssue(kind: RecoveryIssue['kind'], id: string, error: unknown): RecoveryIssue {
  return { kind, id, message: error instanceof Error ? error.message : String(error), observedAt: new Date().toISOString() }
}
