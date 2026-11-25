/** Canonical workspace/path identity and write-claim overlap semantics. */
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { canonicalClaimPath, claimSpanCovers, claimSpanKey, claimSpansOverlap, claimsOverlap,
  comparisonKey, normalizeClaimPath, resolveWorkspaceIdentity, WORKTREE_CLAIM } from '../src/scope.ts'

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'deep-cluster-scope-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

it.each([
  ['src/a.ts', 'src/a.ts', false],
  ['reports/', 'reports', true],
  ['a b/c.txt', 'a b/c.txt', false],
])('normalizes literal claim %s', (raw, normalized, directory) => {
  expect(normalizeClaimPath(raw)).toEqual({ path: normalized, directory, key: normalized })
})

it.each([
  '', '/absolute/file', 'C:/drive/file', '//server/share', 'a\\b', '../escape', 'a/../b', './a',
  '.git/config', 'src/.git/config', '.deep-cluster/journal.jsonl', 'src/*.ts', 'src/[ab].ts', 'src/a?.ts',
  'src//empty', 'trailing.', 'src/a:b',
])('rejects ambiguous or escaping claim %j', (raw) => {
  expect(() => normalizeClaimPath(raw)).toThrow()
})

it('rejects Windows reserved device names only on Windows', () => {
  if (process.platform === 'win32') expect(() => normalizeClaimPath('CON')).toThrow(/reserved/u)
  else expect(normalizeClaimPath('CON')).toEqual({ path: 'CON', directory: false, key: 'CON' })
})

it('overlaps whole worktrees, directories and descendants but not sibling files', () => {
  expect(claimsOverlap(WORKTREE_CLAIM, normalizeClaimPath('src/a.ts'))).toBe(true)
  expect(claimsOverlap(normalizeClaimPath('src/a.ts'), normalizeClaimPath('src/a.ts'))).toBe(true)
  expect(claimsOverlap(normalizeClaimPath('src/'), normalizeClaimPath('src/deep/a.ts'))).toBe(true)
  expect(claimsOverlap(normalizeClaimPath('src/'), normalizeClaimPath('srcx/a.ts'))).toBe(false)
  expect(claimsOverlap(normalizeClaimPath('src/a.ts'), normalizeClaimPath('src/a.ts/child'))).toBe(false)
  expect(claimsOverlap(normalizeClaimPath('src/a'), normalizeClaimPath('src/ab'))).toBe(false)
})

it('compares canonical absolute spans across roots while sibling roots stay parallel', async () => {
  const parent = await scratch()
  const child = path.join(parent, 'child')
  await mkdir(child, { recursive: true })
  const whole = { root: parent, path: '', directory: true }
  const file = { root: child, path: 'a.ts', directory: false }
  expect(claimSpansOverlap(whole, file)).toBe(true)
  expect(claimSpanCovers(whole, claimSpanKey(file))).toBe(true)
  expect(claimSpanCovers(file, claimSpanKey({ root: child, path: 'a.ts', directory: false }))).toBe(true)
  expect(claimSpanCovers(file, claimSpanKey({ root: child, path: 'b.ts', directory: false }))).toBe(false)
  const sibling = await scratch()
  expect(claimSpansOverlap(whole, { root: sibling, path: 'a.ts', directory: false })).toBe(false)
  expect(claimSpansOverlap({ root: path.join(parent, 'ab'), path: '', directory: true }, file)).toBe(false)
})

it('resolves aliases through a directory link to one canonical claim', async (ctx) => {
  const root = await scratch()
  await mkdir(path.join(root, 'real'), { recursive: true })
  await writeFile(path.join(root, 'real', 'a.ts'), 'content\n')
  try {
    await symlink(path.join(root, 'real'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { ctx.skip(); return }
    throw error
  }
  try {
    const direct = await canonicalClaimPath(root, normalizeClaimPath('real/a.ts'))
    const alias = await canonicalClaimPath(root, normalizeClaimPath('alias/a.ts'))
    expect(alias).toEqual(direct)
    expect(claimsOverlap(direct, alias)).toBe(true)
  } finally { await unlink(path.join(root, 'alias')) }
})

it('rejects a claim that escapes through a link and resolves missing descendants under their parent', async (ctx) => {
  const root = await scratch()
  const outside = await scratch()
  try {
    await symlink(outside, path.join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { ctx.skip(); return }
    throw error
  }
  try {
    await expect(canonicalClaimPath(root, normalizeClaimPath('outside/secret.txt'))).rejects.toThrow(/outside worktree/u)
    const missing = await canonicalClaimPath(root, normalizeClaimPath('new/deep/file.txt'))
    expect(missing.path).toBe('new/deep/file.txt')
  } finally { await unlink(path.join(root, 'outside')) }
})

it('keeps Windows comparison keys case-folded and display paths unchanged', async () => {
  const root = await scratch()
  await mkdir(path.join(root, 'Src'), { recursive: true })
  const identity = await resolveWorkspaceIdentity(root)
  if (process.platform === 'win32') {
    expect(comparisonKey(identity.workspace)).toBe(comparisonKey(identity.workspace.toUpperCase()))
    expect((await canonicalClaimPath(root, normalizeClaimPath('src/a.ts'))).key).toBe('src/a.ts')
  } else {
    expect(comparisonKey(identity.workspace)).not.toBe(comparisonKey(identity.workspace.toUpperCase()))
  }
})
