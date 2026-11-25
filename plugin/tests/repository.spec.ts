/** Read-only Git snapshots, dirty-work visibility and bounded drift comparison. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'
import { changeGroups, readGitContext, readRepositorySnapshot, workspaceDrift } from '../src/repository.ts'

const exec = promisify(execFile)

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'deep-cluster-repository-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', root, ...args], { windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout
}

async function repository(): Promise<string> {
  const root = await scratch()
  await git(root, 'init', '-q')
  await git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  await git(root, 'config', 'user.email', 'deep-cluster@example.invalid')
  await git(root, 'config', 'user.name', 'DeepCluster Test')
  await writeFile(path.join(root, 'tracked.txt'), 'base\n')
  await git(root, 'add', 'tracked.txt')
  await git(root, 'commit', '-q', '-m', 'base')
  return root
}

it('snapshots branch, HEAD, staged, dirty and untracked work without mutating Git state', async () => {
  const root = await repository()
  await writeFile(path.join(root, 'tracked.txt'), 'user edit\n')
  await writeFile(path.join(root, 'staged.txt'), 'staged content\n')
  await git(root, 'add', 'staged.txt')
  await writeFile(path.join(root, 'untracked.txt'), 'untracked content\n')
  const before = await git(root, 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z')
  const head = (await git(root, 'rev-parse', 'HEAD')).trim()
  const snapshot = await readRepositorySnapshot(root, {
    fingerprintPaths: ['tracked.txt', 'staged.txt', 'untracked.txt'],
  })
  expect(snapshot.git?.branch).toBe('main')
  expect(snapshot.git?.head).toBe(head)
  expect(snapshot.complete).toBe(true)
  const groups = changeGroups(snapshot)
  expect(groups.modified).toContain('tracked.txt')
  expect(groups.staged).toContain('staged.txt')
  expect(groups.untracked).toContain('untracked.txt')
  expect(snapshot.fingerprints.get('tracked.txt')?.sha256).toMatch(/^[a-f0-9]{64}$/u)
  expect(snapshot.fingerprints.get('untracked.txt')?.exists).toBe(true)
  expect(await git(root, 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z')).toBe(before)
  expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(head)
})

it('detects content changes to already-dirty work and newly staged index state', async () => {
  const root = await repository()
  const paths = ['tracked.txt']
  await writeFile(path.join(root, 'tracked.txt'), 'dirty one\n')
  const first = await readRepositorySnapshot(root, { fingerprintPaths: paths })
  await writeFile(path.join(root, 'tracked.txt'), 'dirty two\n')
  const second = await readRepositorySnapshot(root, { fingerprintPaths: paths })
  const content = workspaceDrift(first, second)
  expect(content.changes.some(change => change.path === 'tracked.txt' && change.reason === 'content' ||
    change.path === 'tracked.txt' && change.reason === 'status')).toBe(true)
  expect(content.headChanged).toBe(false)
  await git(root, 'add', 'tracked.txt')
  const staged = workspaceDrift(second, await readRepositorySnapshot(root, { fingerprintPaths: paths }))
  expect(staged.stagedPaths).toContain('tracked.txt')
})

it('detects staged entry content drift while the porcelain status letters stay unchanged', async () => {
  const root = await repository()
  await writeFile(path.join(root, 'tracked.txt'), 'staged one\n')
  await git(root, 'add', 'tracked.txt')
  const first = await readRepositorySnapshot(root, { fingerprintPaths: ['tracked.txt'] })
  await writeFile(path.join(root, 'tracked.txt'), 'staged two\n')
  await git(root, 'add', 'tracked.txt')
  const second = await readRepositorySnapshot(root, { fingerprintPaths: ['tracked.txt'] })
  const staged = workspaceDrift(first, second)
  expect(staged.headChanged).toBe(false)
  expect(staged.branchChanged).toBe(false)
  expect(staged.indexChanged).toBe(true)
  expect(staged.stagedPaths).toContain('tracked.txt')

  await git(root, 'restore', '--staged', 'tracked.txt')
  const unstaged = workspaceDrift(second, await readRepositorySnapshot(root, { fingerprintPaths: ['tracked.txt'] }))
  expect(unstaged.indexChanged).toBe(true)
  expect(unstaged.stagedPaths).toContain('tracked.txt')

  const beforeDeletion = await readRepositorySnapshot(root, {})
  await git(root, 'rm', '-q', '--cached', 'tracked.txt')
  const afterDeletion = await readRepositorySnapshot(root, {})
  const deleted = workspaceDrift(beforeDeletion, afterDeletion)
  expect(deleted.indexChanged).toBe(true)
  expect(deleted.stagedPaths).toContain('tracked.txt')
  expect(afterDeletion.index?.entries.has('tracked.txt\u00000')).toBe(false)
})

it('walks a non-Git workspace, ignores coordinator metadata and detects content drift', async () => {
  const root = await scratch()
  await mkdir(path.join(root, 'nested'), { recursive: true })
  await mkdir(path.join(root, '.deep-cluster'), { recursive: true })
  await writeFile(path.join(root, '.deep-cluster', 'journal.jsonl'), '{}\n')
  await writeFile(path.join(root, 'nested', 'file.txt'), 'one\n')
  const first = await readRepositorySnapshot(root, { fingerprintPaths: ['nested/file.txt'] })
  expect(first.git).toBeUndefined()
  expect(first.complete).toBe(true)
  expect(first.changes.map(change => change.path)).toEqual(['nested/file.txt'])
  expect(first.changes.some(change => change.path.includes('.deep-cluster'))).toBe(false)
  await writeFile(path.join(root, 'nested', 'file.txt'), 'two\n')
  const second = await readRepositorySnapshot(root, { fingerprintPaths: ['nested/file.txt'] })
  expect(workspaceDrift(first, second).changes).toContainEqual({ path: 'nested/file.txt', reason: 'content' })
})

it('reports a directory outside Git as having no Git context', async () => {
  const root = await scratch()
  await expect(readGitContext(root)).resolves.toBeUndefined()
})
