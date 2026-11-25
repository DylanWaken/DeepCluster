/** Source-mode subprocess fixture: contend for one path claim and prove exclusive holding. */
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireWriteClaims, releaseWriteClaims } from '../src/claims.ts'
import { masterDirectory } from '../src/master.ts'
import { normalizeClaimPath, resolveWorkspaceIdentity } from '../src/scope.ts'

const root = process.argv[2]
const rounds = Number(process.argv[3] ?? '5')
if (root === undefined || !Number.isSafeInteger(rounds) || rounds < 1) {
  throw new Error('claim contention fixture requires a root and a positive round count')
}

const identity = await resolveWorkspaceIdentity(root)
const marker = path.join(root, '.deep-cluster', 'claim-contention-marker')
const claim = {
  scope: identity.worktreeKey,
  root: identity.worktree,
  kind: 'path' as const,
  path: normalizeClaimPath('contended.txt'),
}

for (let round = 0; round < rounds; round++) {
  const set = await acquireWriteClaims(masterDirectory(root), {
    owner: `${String(process.pid)}-${String(round)}`,
    requests: [claim],
    ttlMs: 10_000,
    waitMs: 30_000,
  })
  try {
    try {
      await mkdir(marker)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`two owners held the same claim: ${message}`)
    }
    await delay(5)
    await rm(marker, { recursive: true, force: true })
  } finally {
    await releaseWriteClaims(masterDirectory(root), set)
  }
}

process.stdout.write('done\n')
