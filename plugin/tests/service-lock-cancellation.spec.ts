/** Cancellation and retained ownership of a directly acquired OS endpoint. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { acquireServiceLifecycleLock, ServiceLifecycleLockTimeoutError } from '../src/service-lock.ts'

async function endpoint(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'deepcluster-lock-cancel-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return process.platform === 'win32' ? `\\\\.\\pipe\\deepcluster-lock-${randomUUID()}` : path.join(root, 'lock.sock')
}

it('cancels an occupied-endpoint wait without leaving a later owner behind', async () => {
  const pipeName = await endpoint()
  const release = await acquireServiceLifecycleLock({ pipeName })
  const controller = new AbortController()
  const pending = acquireServiceLifecycleLock({ pipeName, signal: controller.signal })
  controller.abort(new Error('cancelled waiter'))
  try {
    await expect(pending).rejects.toThrow()
  } finally {
    await release()
  }
  const nextRelease = await acquireServiceLifecycleLock({ pipeName, timeoutMs: 0 })
  await nextRelease()
  await nextRelease()
})

it('keeps an acquired endpoint owned after cancellation until explicit release', async () => {
  const pipeName = await endpoint()
  const controller = new AbortController()
  const release = await acquireServiceLifecycleLock({ pipeName, signal: controller.signal })
  controller.abort()
  try {
    await expect(acquireServiceLifecycleLock({ pipeName, timeoutMs: 0 })).rejects.toBeInstanceOf(ServiceLifecycleLockTimeoutError)
  } finally {
    await release()
  }
  await (await acquireServiceLifecycleLock({ pipeName, timeoutMs: 0 }))()
})

it('never binds an endpoint for an already cancelled owner', async () => {
  const pipeName = await endpoint()
  const controller = new AbortController()
  const reason = new Error('already cancelled')
  controller.abort(reason)
  await expect(acquireServiceLifecycleLock({ pipeName, signal: controller.signal })).rejects.toBe(reason)
  await (await acquireServiceLifecycleLock({ pipeName, timeoutMs: 0 }))()
})
