/** Registry mutex recovery, cross-process contention and bounded released-claim evidence. */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { acquireWriteClaims, listWriteClaims, readClaimHistory, releaseWriteClaims, type ClaimRequest } from '../src/claims.ts'
import { masterDirectory } from '../src/master.ts'
import { normalizeClaimPath, resolveWorkspaceIdentity } from '../src/scope.ts'

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'deep-cluster-claim-registry-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

interface FixtureResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

function run(fixture: string, root: string, extra: readonly string[] = []): Promise<FixtureResult> {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', fileURLToPath(new URL(fixture, import.meta.url)), root, ...extra],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
  const exited = new Promise<FixtureResult>((resolve) => {
    child.once('exit', (code) => { resolve({ code, stdout, stderr }) })
  })
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  })
  return exited
}

async function claim(root: string, file: string): Promise<ClaimRequest> {
  const identity = await resolveWorkspaceIdentity(root)
  return { scope: identity.worktreeKey, root: identity.worktree, kind: 'path', path: normalizeClaimPath(file) }
}

async function claimFiles(root: string): Promise<string[]> {
  try {
    return (await readdir(path.join(masterDirectory(root), 'claims'))).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

it('never takes over a stale-looking mutex and admits a new owner only after explicit removal', async () => {
  const root = await scratch()
  const claims = path.join(masterDirectory(root), 'claims')
  const mutex = path.join(claims, 'mutex')
  await mkdir(mutex, { recursive: true })
  const owner = JSON.stringify({ pid: 2_147_483_647, token: 'abandoned-owner',
    at: new Date(Date.now() - 60_000).toISOString() })
  await writeFile(path.join(mutex, 'owner.json'), owner)

  const [first, second] = await Promise.all([
    run('./orchestration-claims-acquire.fixture.ts', root),
    run('./orchestration-claims-acquire.fixture.ts', root),
  ])
  for (const result of [first, second]) {
    expect(result.code).toBe(3)
    expect(result.stdout).toContain('failed:WriteClaimStateError:')
    expect(result.stdout).toContain('automatic takeover is disabled')
  }
  expect(await readFile(path.join(mutex, 'owner.json'), 'utf8')).toBe(owner)
  expect((await claimFiles(root)).filter(name => name !== 'mutex' && !name.startsWith('mutex.'))).toEqual([])

  await rm(mutex, { recursive: true, force: true })
  const [third, fourth] = await Promise.all([
    run('./orchestration-claims-acquire.fixture.ts', root),
    run('./orchestration-claims-acquire.fixture.ts', root),
  ])
  expect(third.code, third.stderr).toBe(0)
  expect(fourth.code, fourth.stderr).toBe(0)
  expect(await listWriteClaims(masterDirectory(root))).toEqual([])
}, 20_000)

it('serializes four independent processes through repeated acquire and release rounds', async () => {
  const root = await scratch()
  const results = await Promise.all(Array.from({ length: 4 },
    () => run('./orchestration-claims-contention.fixture.ts', root, ['5'])))
  for (const result of results) expect(result.code, result.stderr || result.stdout).toBe(0)
  expect(await listWriteClaims(masterDirectory(root))).toEqual([])
  expect((await claimFiles(root)).some(name => name === 'claim-contention-marker')).toBe(false)
}, 40_000)

it('retains released evidence, prunes by bounded retention and reports what it removed', async () => {
  const root = await scratch()
  const first = await acquireWriteClaims(masterDirectory(root), { owner: 'first', requests: [await claim(root, 'first.txt')], waitMs: 0 })
  await releaseWriteClaims(masterDirectory(root), first)
  const released = (await readClaimHistory(masterDirectory(root))).records.filter(record => record.releasedAt !== undefined)
  expect(released).toHaveLength(1)
  expect(await listWriteClaims(masterDirectory(root))).toEqual([])

  const identity = await resolveWorkspaceIdentity(root)
  await writeFile(path.join(masterDirectory(root), 'claim-history.json'), JSON.stringify({ records: [{
    id: 'old.json', root: identity.worktree, scope: identity.worktreeKey, kind: 'path', path: 'old.txt',
    directory: false, owner: 'old', token: 'old-token', pid: process.pid,
    acquiredAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:10:00.000Z',
    releasedAt: '2020-01-01T00:05:00.000Z',
  }] }))
  const second = await acquireWriteClaims(masterDirectory(root), { owner: 'second', requests: [await claim(root, 'second.txt')], waitMs: 0 })
  await releaseWriteClaims(masterDirectory(root), second)

  const history = await readClaimHistory(masterDirectory(root))
  expect(history.prunedThrough).toBe('2020-01-01T00:05:00.000Z')
  expect(history.records.some(record => record.id === 'old.json')).toBe(false)
  expect(history.records.filter(record => record.releasedAt !== undefined)).toHaveLength(1)
  expect(await listWriteClaims(masterDirectory(root))).toEqual([])
}, 20_000)
