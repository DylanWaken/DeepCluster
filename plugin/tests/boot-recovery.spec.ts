/** Previous-boot ownership recovery preserves evidence and never signals recorded PIDs. */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { inspectPreviousBootOwnership, inspectWindowsBoot, predatesWindowsBoot, quarantinePreviousBootOwnership,
  type WindowsBootEvidence } from '../src/boot-recovery.ts'

const boot: WindowsBootEvidence = { startedAt: '2026-02-02T00:00:00.000Z', observedAt: '2026-02-02T12:00:00.000Z' }
const previous = '2026-02-01T00:00:00.000Z'
const lease = { resource: 'gpu0', owner: 'old-run', token: 'held-token', pid: process.pid,
  acquiredAt: previous, expiresAt: '2026-02-01T01:00:00.000Z' }

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'deepcluster-boot-recovery-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await Promise.all(['leases', 'claims'].map(name => mkdir(path.join(root, name))))
  const put = async (relative: string, value: unknown) => {
    const file = path.join(root, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(value))
    return file
  }
  return { root, put }
}

it('validates the host boot observation and compares only earlier valid timestamps', async () => {
  let script = ''
  expect(await inspectWindowsBoot(async (value) => { script = value; return `BOOT|${boot.startedAt}|${boot.observedAt}` })).toEqual(boot)
  expect(script).toContain('Get-CimInstance Win32_OperatingSystem -ErrorAction Stop')
  expect(predatesWindowsBoot(previous, boot)).toBe(true)
  for (const value of [undefined, 'invalid', boot.startedAt, boot.observedAt]) expect(predatesWindowsBoot(value, boot)).toBe(false)
})

it.each(['', 'BOOT|invalid|invalid', 'BOOT|2026-02-03T00:00:00Z|2026-02-02T00:00:00Z', 'extra\nBOOT|a|b'])(
  'rejects invalid host boot output %s', async (output) => {
    await expect(inspectWindowsBoot(async () => output)).rejects.toMatchObject({ code: 'invalid-boot' })
  },
)

it('quarantines prior-boot leases, waiters, claims and a mutex while preserving unrelated history and reused PIDs', async () => {
  const h = await fixture()
  const ticket = `leases/gpu0.ticket-${String(Date.parse(previous)).padStart(15, '0')}-p${String(process.pid)}-abc123`
  const entries = {
    'leases/gpu0.lock': lease,
    [ticket]: { owner: lease.owner, pid: lease.pid },
    'claims/claim.json': { id: 'claim.json', scope: h.root, root: h.root, kind: 'path', path: 'src/', directory: true,
      owner: lease.owner, token: lease.token, pid: lease.pid, acquiredAt: previous, expiresAt: lease.expiresAt },
    'claims/mutex/owner.json': { pid: lease.pid, token: lease.token, at: previous },
  }
  for (const [relative, value] of Object.entries(entries)) await h.put(relative, value)
  const history = await h.put('claim-history.json', { records: ['retained-release'] })
  const operations = await h.put('operations/old.json', { status: 'running', instruction: 'preserved-operation' })
  const inspection = await inspectPreviousBootOwnership(h.root, boot)
  expect(inspection.retained).toEqual([])
  expect(inspection.candidates.map(item => item.kind).sort()).toEqual(['claim', 'claim-mutex', 'lease', 'waiter'])
  const recovered = await quarantinePreviousBootOwnership(inspection)
  expect(recovered.moved).toHaveLength(4)
  expect(await readdir(path.join(h.root, 'leases'))).toEqual([])
  expect(await readdir(path.join(h.root, 'claims'))).toEqual([])
  for (const [relative, value] of Object.entries(entries)) {
    expect(JSON.parse(await readFile(path.join(recovered.quarantineDirectory!, relative), 'utf8'))).toEqual(value)
  }
  expect(JSON.parse(await readFile(history, 'utf8'))).toEqual({ records: ['retained-release'] })
  expect(JSON.parse(await readFile(operations, 'utf8'))).toEqual({ status: 'running', instruction: 'preserved-operation' })
  expect(await readFile(path.join(recovered.quarantineDirectory!, 'manifest.json'), 'utf8')).not.toContain(lease.token)
  expect(process.kill(process.pid, 0)).toBe(true)
  expect(await quarantinePreviousBootOwnership(await inspectPreviousBootOwnership(h.root, boot)))
    .toEqual({ quarantineDirectory: null, moved: [], retained: [] })
})

it('retains current-boot, malformed, mismatched and unknown entries without treating PID absence as cleanup', async () => {
  const h = await fixture()
  await h.put('leases/gpu0.lock', { ...lease, acquiredAt: boot.startedAt })
  await h.put('leases/mismatch.lock', lease)
  await h.put('leases/gpu0.ticket-123-p999-bad', { owner: 'old', pid: 12 })
  await h.put('leases/partial.tmp', {})
  await writeFile(path.join(h.root, 'leases', 'corrupt.lock'), '{')
  await h.put('claims/bad.json', { id: 'other.json' })
  await h.put('claims/mutex/owner.json', { pid: 123, token: 'old', at: previous })
  await h.put('claims/mutex/extra.json', {})
  const inspection = await inspectPreviousBootOwnership(h.root, boot)
  expect(inspection.candidates).toEqual([])
  expect(inspection.retained).toHaveLength(7)
  expect((await quarantinePreviousBootOwnership(inspection)).quarantineDirectory).toBeNull()
  expect(JSON.parse(await readFile(path.join(h.root, 'leases', 'gpu0.lock'), 'utf8'))).toMatchObject({ acquiredAt: boot.startedAt })
})

it('rechecks every candidate before moving any and refuses changed bytes or replacement identities', async () => {
  const h = await fixture()
  const file = await h.put('leases/gpu0.lock', lease)
  await h.put('leases/gpu1.lock', { ...lease, resource: 'gpu1' })
  const first = await inspectPreviousBootOwnership(h.root, boot)
  await writeFile(file, JSON.stringify({ ...lease, token: 'replacement-token' }))
  await expect(quarantinePreviousBootOwnership(first)).rejects.toMatchObject({ code: 'ownership-changed' })
  expect(await readdir(path.join(h.root, 'leases'))).toHaveLength(2)
  const second = await inspectPreviousBootOwnership(h.root, boot)
  const replacement = await h.put('replacement.json', { ...lease, token: 'replacement-token' })
  await rename(replacement, file)
  await expect(quarantinePreviousBootOwnership(second)).rejects.toMatchObject({ code: 'ownership-changed' })
  expect(await readdir(path.join(h.root, 'leases'))).toHaveLength(2)
})

it('does not follow linked ownership namespaces or quarantine directories', async () => {
  const h = await fixture(), external = path.join(h.root, 'external')
  await mkdir(external)
  await rmdir(path.join(h.root, 'claims'))
  await symlink(external, path.join(h.root, 'claims'), process.platform === 'win32' ? 'junction' : 'dir')
  try {
    expect((await inspectPreviousBootOwnership(h.root, boot)).retained).toMatchObject([{ relativePath: 'claims' }])
  } finally { await unlink(path.join(h.root, 'claims')) }
  await mkdir(path.join(h.root, 'claims'))
  await h.put('leases/gpu0.lock', lease)
  const inspection = await inspectPreviousBootOwnership(h.root, boot)
  await symlink(external, path.join(h.root, 'recovered'), process.platform === 'win32' ? 'junction' : 'dir')
  try {
    await expect(quarantinePreviousBootOwnership(inspection)).rejects.toMatchObject({ code: 'ownership-changed' })
    expect(await readdir(external)).toEqual([])
  } finally { await unlink(path.join(h.root, 'recovered')) }
})
