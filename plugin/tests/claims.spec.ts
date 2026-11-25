/** Cross-process write claims: atomic acquisition, ancestor overlap, renewal and token ownership. */
import { spawn, execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { acquireWriteClaims, claimRequestsOverlap, listWriteClaims, releaseWriteClaims, renewWriteClaims,
  writeClaimStatus, WriteClaimLostError, WriteClaimStateError, WriteClaimTimeoutError, type ClaimRequest } from '../src/claims.ts'
import { normalizeClaimPath, resolveWorkspaceIdentity, WORKTREE_CLAIM } from '../src/scope.ts'
import { masterDirectory } from '../src/master.ts'
import { readGitContext } from '../src/repository.ts'
import type { LeaseToken } from '../src/types.ts'

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'deep-cluster-claims-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

async function request(root: string, claim: string | undefined): Promise<{ scope: string; root: string; request: ClaimRequest }> {
  const identity = await resolveWorkspaceIdentity(root)
  return {
    scope: identity.worktreeKey,
    root: identity.worktree,
    request: claim === undefined
      ? { scope: identity.worktreeKey, root: identity.worktree, kind: 'worktree', path: WORKTREE_CLAIM }
      : { scope: identity.worktreeKey, root: identity.worktree, kind: 'path',
        path: { path: claim.replace(/\/$/u, ''), directory: claim.endsWith('/'), key: claim.replace(/\/$/u, '') } },
  }
}

it('serializes the same path and directory descendants and rejects a conflicting request', async () => {
  const root = await scratch()
  const scope = (await resolveWorkspaceIdentity(root)).worktreeKey
  const ancestor: ClaimRequest = { scope, root, kind: 'path', path: { path: 'src', directory: true, key: 'src' } }
  const descendant: ClaimRequest = { scope, root, kind: 'path', path: { path: 'src/a.ts', directory: false, key: 'src/a.ts' } }
  const first = await acquireWriteClaims(masterDirectory(root), { owner: 'first', requests: [ancestor], waitMs: 0 })
  await expect(acquireWriteClaims(masterDirectory(root), { owner: 'second', requests: [descendant], waitMs: 0 }))
    .rejects.toBeInstanceOf(WriteClaimTimeoutError)
  expect((await writeClaimStatus(masterDirectory(root), scope, [descendant])).conflicts).toHaveLength(1)
  await releaseWriteClaims(masterDirectory(root), first)
  const second = await acquireWriteClaims(masterDirectory(root), { owner: 'second', requests: [descendant], waitMs: 0 })
  await releaseWriteClaims(masterDirectory(root), second)
})

it('keeps disjoint paths and separate worktrees concurrent', async () => {
  const root = await scratch()
  const scope = (await resolveWorkspaceIdentity(root)).worktreeKey
  const left: ClaimRequest = { scope, root, kind: 'path', path: { path: 'left.txt', directory: false, key: 'left.txt' } }
  const right: ClaimRequest = { scope, root, kind: 'path', path: { path: 'right.txt', directory: false, key: 'right.txt' } }
  const first = await acquireWriteClaims(masterDirectory(root), { owner: 'left', requests: [left], waitMs: 0 })
  const second = await acquireWriteClaims(masterDirectory(root), { owner: 'right', requests: [right], waitMs: 0 })
  expect((await listWriteClaims(masterDirectory(root), scope)).map(record => record.owner).sort()).toEqual(['left', 'right'])
  await releaseWriteClaims(masterDirectory(root), first)
  await releaseWriteClaims(masterDirectory(root), second)
})

it('reserves the whole worktree by default and never replaces it', async () => {
  const root = await scratch()
  const scope = (await resolveWorkspaceIdentity(root)).worktreeKey
  const whole: ClaimRequest = { scope, root, kind: 'worktree', path: WORKTREE_CLAIM }
  const pathClaim: ClaimRequest = { scope, root, kind: 'path', path: { path: 'a.txt', directory: false, key: 'a.txt' } }
  const first = await acquireWriteClaims(masterDirectory(root), { owner: 'whole', requests: [whole], waitMs: 0 })
  await expect(acquireWriteClaims(masterDirectory(root), { owner: 'path', requests: [pathClaim], waitMs: 0 })).rejects.toBeInstanceOf(WriteClaimTimeoutError)
  await releaseWriteClaims(masterDirectory(root), first)
  const second = await acquireWriteClaims(masterDirectory(root), { owner: 'path', requests: [pathClaim], waitMs: 0 })
  await releaseWriteClaims(masterDirectory(root), second)
})

it('never reclaims an expired claim and reports it as stale', async () => {
  const root = await scratch()
  const { scope, request: claim } = await request(root, 'src/a.ts')
  const held = await acquireWriteClaims(masterDirectory(root), { owner: 'held', requests: [claim], ttlMs: 1, waitMs: 0 })
  await new Promise(resolve => setTimeout(resolve, 15))
  const status = await writeClaimStatus(masterDirectory(root), scope, [claim])
  expect(status.stale).toBe(true)
  expect(status.held).toHaveLength(1)
  await expect(acquireWriteClaims(masterDirectory(root), { owner: 'thief', requests: [claim], waitMs: 0 })).rejects.toBeInstanceOf(WriteClaimTimeoutError)
  await releaseWriteClaims(masterDirectory(root), held)
})

it('renews owned claims and fails closed when the record is lost', async () => {
  const root = await scratch()
  const { request: claim } = await request(root, 'src/a.ts')
  const held = await acquireWriteClaims(masterDirectory(root), { owner: 'owner', requests: [claim], ttlMs: 1_000, waitMs: 0 })
  const renewed = await renewWriteClaims(masterDirectory(root), held, 60_000)
  expect(Date.parse(renewed.records[0]?.expiresAt ?? '')).toBeGreaterThan(Date.now() + 30_000)
  const [record] = renewed.records
  if (record === undefined) throw new Error('expected one claim record')
  await unlink(path.join(masterDirectory(root), 'claims', record.id))
  await expect(renewWriteClaims(masterDirectory(root), renewed, 60_000)).rejects.toBeInstanceOf(WriteClaimLostError)
})

it('refuses to release another token and refuses corrupt claim state', async () => {
  const root = await scratch()
  const { request: claim } = await request(root, 'src/a.ts')
  const held = await acquireWriteClaims(masterDirectory(root), { owner: 'owner', requests: [claim], waitMs: 0 })
  await expect(releaseWriteClaims(masterDirectory(root), { ...held, token: 'foreign' as LeaseToken })).rejects.toBeInstanceOf(WriteClaimLostError)
  expect((await listWriteClaims(masterDirectory(root), held.records[0]?.scope)).length).toBe(1)
  await writeFile(path.join(masterDirectory(root), 'claims', 'corrupt.json'), '{')
  await expect(acquireWriteClaims(masterDirectory(root), { owner: 'other', requests: [claim], waitMs: 0 })).rejects.toBeInstanceOf(WriteClaimStateError)
  await releaseWriteClaims(masterDirectory(root), held)
})

interface Child {
  readonly send: (message: string) => void
  readonly started: Promise<void>
  readonly exited: Promise<{ code: number | null; stderr: string }>
}

function child(root: string, claimPath: string | undefined): Child {
  const fixture = fileURLToPath(new URL('./orchestration-claims-worker.fixture.ts', import.meta.url))
  const processChild = spawn(process.execPath, ['--import', 'tsx/esm', fixture, root, claimPath ?? '*'],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
  let stderr = ''
  const started = Promise.withResolvers<undefined>()
  processChild.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })
  processChild.on('message', (message) => { if (message === 'started') started.resolve(undefined) })
  processChild.on('error', (error) => { started.reject(error) })
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    processChild.once('exit', (code) => { resolve({ code, stderr }) })
  })
  onTestFinished(async () => {
    if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill()
    await exited
  })
  return {
    send: (message) => { processChild.send(message) },
    started: started.promise,
    exited,
  }
}

it('lets separate physical worktrees proceed while serializing shared Git metadata', async () => {
  const exec = promisify(execFile)
  const repo = await scratch()
  await exec('git', ['-C', repo, 'init', '-q'], { windowsHide: true })
  await exec('git', ['-C', repo, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { windowsHide: true })
  await exec('git', ['-C', repo, 'config', 'user.email', 'deep-cluster@example.invalid'], { windowsHide: true })
  await exec('git', ['-C', repo, 'config', 'user.name', 'DeepCluster Test'], { windowsHide: true })
  await writeFile(path.join(repo, 'tracked.txt'), 'base\n')
  await exec('git', ['-C', repo, 'add', 'tracked.txt'], { windowsHide: true })
  await exec('git', ['-C', repo, 'commit', '-q', '-m', 'base'], { windowsHide: true })
  const secondRoot = await scratch()
  await exec('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'second', secondRoot], { windowsHide: true })
  const firstGit = await readGitContext(repo)
  const secondGit = await readGitContext(secondRoot)
  const first = await resolveWorkspaceIdentity(repo, firstGit)
  const second = await resolveWorkspaceIdentity(secondRoot, secondGit)
  expect(first.worktreeKey).not.toBe(second.worktreeKey)
  expect(first.commonDirKey).toBeDefined()
  expect(first.commonDirKey).toBe(second.commonDirKey)
  const metadata = (scope: string, root: string): ClaimRequest => ({ scope, root, kind: 'metadata', path: WORKTREE_CLAIM })
  const whole = (scope: string, root: string): ClaimRequest => ({ scope, root, kind: 'worktree', path: WORKTREE_CLAIM })
  const firstWorktree = await acquireWriteClaims(masterDirectory(repo), { owner: 'first', requests: [whole(first.worktreeKey, first.worktree)], waitMs: 0 })
  const secondWorktree = await acquireWriteClaims(masterDirectory(repo), { owner: 'second', requests: [whole(second.worktreeKey, second.worktree)], waitMs: 0 })
  expect(secondWorktree.records).toHaveLength(1)
  const firstMetadata = await acquireWriteClaims(masterDirectory(repo), { owner: 'first-git',
    requests: [metadata(first.commonDirKey as string, first.commonDir as string)], waitMs: 0 })
  await expect(acquireWriteClaims(masterDirectory(repo), { owner: 'second-git',
    requests: [metadata(second.commonDirKey as string, second.commonDir as string)], waitMs: 0 }))
    .rejects.toBeInstanceOf(WriteClaimTimeoutError)
  await releaseWriteClaims(masterDirectory(repo), firstWorktree)
  await releaseWriteClaims(masterDirectory(repo), secondWorktree)
  await releaseWriteClaims(masterDirectory(repo), firstMetadata)
})

it('conflicts on physical paths across non-Git parent and child workspace roots', async () => {
  const parent = await scratch()
  const child = path.join(parent, 'child')
  await mkdir(child, { recursive: true })
  const parentIdentity = await resolveWorkspaceIdentity(parent)
  const childIdentity = await resolveWorkspaceIdentity(child)
  expect(parentIdentity.worktreeKey).not.toBe(childIdentity.worktreeKey)
  const whole: ClaimRequest = { scope: parentIdentity.worktreeKey, root: parentIdentity.worktree,
    kind: 'worktree', path: WORKTREE_CLAIM }
  const file: ClaimRequest = { scope: childIdentity.worktreeKey, root: childIdentity.worktree,
    kind: 'path', path: normalizeClaimPath('file.txt') }
  expect(claimRequestsOverlap(whole, file)).toBe(true)

  const held = await acquireWriteClaims(masterDirectory(parent), { owner: 'parent', requests: [whole], waitMs: 0 })
  await expect(acquireWriteClaims(masterDirectory(parent), { owner: 'child', requests: [file], waitMs: 0 }))
    .rejects.toBeInstanceOf(WriteClaimTimeoutError)
  await releaseWriteClaims(masterDirectory(parent), held)

  const childHeld = await acquireWriteClaims(masterDirectory(parent), { owner: 'child', requests: [file], waitMs: 0 })
  await expect(acquireWriteClaims(masterDirectory(parent), { owner: 'parent', requests: [whole], waitMs: 0 }))
    .rejects.toBeInstanceOf(WriteClaimTimeoutError)
  await releaseWriteClaims(masterDirectory(parent), childHeld)

  const sibling = await scratch()
  const siblingIdentity = await resolveWorkspaceIdentity(sibling)
  const siblingFile: ClaimRequest = { scope: siblingIdentity.worktreeKey, root: siblingIdentity.worktree,
    kind: 'path', path: normalizeClaimPath('file.txt') }
  expect(claimRequestsOverlap(whole, siblingFile)).toBe(false)
})

it('conflicts a nested repository and an outside non-Git ancestor with the same physical files', async () => {
  const exec = promisify(execFile)
  const outer = await scratch()
  await exec('git', ['-C', outer, 'init', '-q'], { windowsHide: true })
  const nested = path.join(outer, 'nested')
  await mkdir(nested, { recursive: true })
  await exec('git', ['-C', nested, 'init', '-q'], { windowsHide: true })
  const outerIdentity = await resolveWorkspaceIdentity(outer, await readGitContext(outer))
  const nestedIdentity = await resolveWorkspaceIdentity(nested, await readGitContext(nested))
  expect(outerIdentity.worktreeKey).not.toBe(nestedIdentity.worktreeKey)
  const outerWhole: ClaimRequest = { scope: outerIdentity.worktreeKey, root: outerIdentity.worktree,
    kind: 'worktree', path: WORKTREE_CLAIM }
  const nestedFile: ClaimRequest = { scope: nestedIdentity.worktreeKey, root: nestedIdentity.worktree,
    kind: 'path', path: normalizeClaimPath('file.txt') }
  const held = await acquireWriteClaims(masterDirectory(outer), { owner: 'outer', requests: [outerWhole], waitMs: 0 })
  await expect(acquireWriteClaims(masterDirectory(outer), { owner: 'nested', requests: [nestedFile], waitMs: 0 }))
    .rejects.toBeInstanceOf(WriteClaimTimeoutError)
  await releaseWriteClaims(masterDirectory(outer), held)

  const parent = await scratch()
  const repository = path.join(parent, 'repository')
  await mkdir(repository, { recursive: true })
  await exec('git', ['-C', repository, 'init', '-q'], { windowsHide: true })
  const parentIdentity = await resolveWorkspaceIdentity(parent)
  const repositoryIdentity = await resolveWorkspaceIdentity(repository, await readGitContext(repository))
  const parentWhole: ClaimRequest = { scope: parentIdentity.worktreeKey, root: parentIdentity.worktree,
    kind: 'worktree', path: WORKTREE_CLAIM }
  const repositoryFile: ClaimRequest = { scope: repositoryIdentity.worktreeKey, root: repositoryIdentity.worktree,
    kind: 'path', path: normalizeClaimPath('file.txt') }
  expect(claimRequestsOverlap(parentWhole, repositoryFile)).toBe(true)
  const parentHeld = await acquireWriteClaims(masterDirectory(parent), { owner: 'ancestor', requests: [parentWhole], waitMs: 0 })
  await expect(acquireWriteClaims(masterDirectory(parent), { owner: 'repository', requests: [repositoryFile], waitMs: 0 }))
    .rejects.toBeInstanceOf(WriteClaimTimeoutError)
  await releaseWriteClaims(masterDirectory(parent), parentHeld)
})

it('never reclaims a claim recorded with a dead owner and an expired deadline', async () => {
  const root = await scratch()
  const { request: claimRequest } = await request(root, 'src/a.ts')
  const held = await acquireWriteClaims(masterDirectory(root), { owner: 'owner', requests: [claimRequest], ttlMs: 1_000, waitMs: 0 })
  const [record] = held.records
  if (record === undefined) throw new Error('expected one claim record')
  const file = path.join(masterDirectory(root), 'claims', record.id)
  await writeFile(file, JSON.stringify({ ...record, pid: 2_147_483_647, expiresAt: '1970-01-01T00:00:00.000Z' }))
  await expect(acquireWriteClaims(masterDirectory(root), { owner: 'thief', requests: [claimRequest], waitMs: 0 }))
    .rejects.toBeInstanceOf(WriteClaimTimeoutError)
  expect((await listWriteClaims(masterDirectory(root))).map(item => item.id)).toEqual([record.id])
  await releaseWriteClaims(masterDirectory(root), held)
})

it('races independent coordinators across processes on the same and ancestor paths', async () => {
  const root = await scratch()
  await mkdir(path.join(root, 'src'), { recursive: true })
  const cases: [string | undefined, string][] = [[undefined, 'src/a.ts'], ['src/', 'src/a.ts'], ['src/a.ts', 'src/a.ts']]
  for (const [firstPath, secondPath] of cases) {
    const first = child(root, firstPath)
    await first.started
    const second = child(root, secondPath)
    const blocked = await Promise.race([
      second.started.then(() => 'started' as const),
      second.exited.then(() => 'exited' as const),
      new Promise<'waiting'>(resolve => setTimeout(() => { resolve('waiting') }, 300)),
    ])
    expect(blocked, `second coordinator on ${secondPath} must wait for ${firstPath ?? 'the whole worktree'}`).toBe('waiting')
    first.send('release')
    const firstExit = await first.exited
    expect(firstExit.code, firstExit.stderr).toBe(0)
    await second.started
    second.send('release')
    const secondExit = await second.exited
    expect(secondExit.code, secondExit.stderr).toBe(0)
    expect(await listWriteClaims(masterDirectory(root))).toEqual([])
  }
}, 20_000)

it('lets disjoint claims start concurrently in independent processes', async () => {
  const root = await scratch()
  const first = child(root, 'src/a.ts')
  const second = child(root, 'src/b.ts')
  await Promise.all([first.started, second.started])
  first.send('release')
  second.send('release')
  const [left, right] = await Promise.all([first.exited, second.exited])
  expect(left.code, left.stderr).toBe(0)
  expect(right.code, right.stderr).toBe(0)
  expect(await listWriteClaims(masterDirectory(root))).toEqual([])
}, 20_000)
