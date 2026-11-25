/** Source-mode subprocess fixture: acquire one path claim and report the typed failure. */
import { acquireWriteClaims, releaseWriteClaims } from '../src/claims.ts'
import { masterDirectory } from '../src/master.ts'
import { normalizeClaimPath, resolveWorkspaceIdentity } from '../src/scope.ts'

const root = process.argv[2]
const owner = process.argv[3] ?? `fixture-${String(process.pid)}`
if (root === undefined) throw new Error('claim acquire fixture requires a root')

const identity = await resolveWorkspaceIdentity(root)
try {
  const set = await acquireWriteClaims(masterDirectory(root), {
    owner,
    requests: [{ scope: identity.worktreeKey, root: identity.worktree, kind: 'path', path: normalizeClaimPath('locked.txt') }],
    waitMs: 250,
  })
  await releaseWriteClaims(masterDirectory(root), set)
  process.stdout.write('acquired\n')
} catch (error) {
  const name = error instanceof Error ? error.name : 'unknown'
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(`failed:${name}:${message}\n`)
  process.exitCode = 3
}
