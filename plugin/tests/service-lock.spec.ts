/** Serial and abandoned ownership behavior of the direct Node service lifecycle lock. */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { ServiceLifecycleLockTimeoutError, withServiceLifecycleLock } from '../src/service-lock.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/service-lock-child.ts', import.meta.url))

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'deep-cluster-service-lock-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

/** Disposable endpoint: a unique named pipe on Windows and a temp-directory socket elsewhere. */
async function disposableEndpoint(root: string): Promise<string> {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\deepcluster-service-lock-test-${randomUUID()}`
    : path.join(root, 'service-lock.sock')
}

async function readMarkers(file: string): Promise<string[]> {
  try {
    return (await readFile(file, 'utf8')).trim().split('\n').filter(line => line !== '')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

interface ControllerChild {
  readonly process: ChildProcess
  readonly acquired: Promise<void>
  readonly exited: Promise<{ readonly code: number | null; readonly stderr: string }>
}

function spawnController(root: string, endpoint: string, mode: 'serial' | 'hold', id: string, holdMs = 0): ControllerChild {
  const child = spawn(process.execPath,
    ['--import', 'tsx/esm', FIXTURE, mode, endpoint, path.join(root, 'markers.log'), id, String(holdMs)],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
  let stderr = ''
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })
  const acquired = Promise.withResolvers<undefined>()
  // Observe the readiness rejection without making a later exit the only handler.
  void acquired.promise.catch(() => { /* the waiting test reports the failure */ })
  child.on('message', (message) => { if (message === 'acquired') acquired.resolve(undefined) })
  child.once('error', (error) => { acquired.reject(error) })
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.once('close', (code) => { resolve({ code, stderr }) })
  })
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  })
  return { process: child, acquired: acquired.promise, exited }
}

async function waitForAcquisition(child: ControllerChild): Promise<void> {
  await Promise.race([
    child.acquired,
    child.exited.then(({ code, stderr }) => {
      throw new Error(`controller exited before acquiring (code ${String(code)}): ${stderr}`)
    }),
  ])
}

it('serializes independent controller subprocesses without overlapping enter and exit markers', { timeout: 30_000 }, async () => {
  const root = await scratch()
  const endpoint = await disposableEndpoint(root)
  const ids = ['alpha', 'beta', 'gamma']
  const children = ids.map(id => spawnController(root, endpoint, 'serial', id, 120))
  const exits = await Promise.all(children.map(child => child.exited))
  expect(exits.map(exit => exit.code)).toEqual([0, 0, 0])
  expect(exits.map(exit => exit.stderr)).toEqual(['', '', ''])
  const log = await readMarkers(path.join(root, 'markers.log'))
  expect(log).toHaveLength(ids.length * 2)
  let active: string | undefined
  for (const line of log) {
    const [event, id] = line.split(' ')
    if (event === 'enter') {
      expect(active).toBeUndefined()
      active = id
    } else {
      expect(event).toBe('exit')
      expect(id).toBe(active)
      active = undefined
    }
  }
  expect(active).toBeUndefined()
  expect(log.filter(line => line.startsWith('enter ')).map(line => line.slice('enter '.length)).sort()).toEqual([...ids].sort())
})

it('releases the endpoint promptly after the owning controller process is killed', { timeout: 30_000 }, async () => {
  const root = await scratch()
  const endpoint = await disposableEndpoint(root)
  const markers = path.join(root, 'markers.log')
  const owner = spawnController(root, endpoint, 'hold', 'owner')
  await waitForAcquisition(owner)
  expect(await readMarkers(markers)).toEqual(['enter owner'])
  owner.process.kill()
  const ownerExit = await owner.exited
  expect(ownerExit.code).not.toBe(0)
  // A Unix socket path survives SIGKILL; Windows releases the named pipe with the process handle.
  if (process.platform !== 'win32') await rm(endpoint, { force: true })
  const started = Date.now()
  const contender = spawnController(root, endpoint, 'serial', 'contender')
  const contenderExit = await contender.exited
  expect(contenderExit.code, contenderExit.stderr).toBe(0)
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(await readMarkers(markers)).toEqual(['enter owner', 'enter contender', 'exit contender'])
})

it('releases the lock after a rejecting action and preserves the primary error', async () => {
  const root = await scratch()
  const endpoint = await disposableEndpoint(root)
  const failure = new Error('focused lifecycle action failed')
  await expect(withServiceLifecycleLock(async () => { throw failure }, { pipeName: endpoint })).rejects.toBe(failure)
  await expect(withServiceLifecycleLock(async () => 'released', { pipeName: endpoint })).resolves.toBe('released')
})

it('keeps the action unrun when the bounded wait expires', async () => {
  const root = await scratch()
  const endpoint = await disposableEndpoint(root)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const owner = withServiceLifecycleLock(async () => {
    entered.resolve(undefined)
    await release.promise
  }, { pipeName: endpoint, timeoutMs: 5_000 })
  await entered.promise
  let actionRan = false
  try {
    const attempt = withServiceLifecycleLock(async () => { actionRan = true }, { pipeName: endpoint, timeoutMs: 250 })
    await expect(attempt).rejects.toBeInstanceOf(ServiceLifecycleLockTimeoutError)
    const failure = await attempt.catch((error: unknown) => error)
    const message = failure instanceof Error ? failure.message : ''
    expect(message).toMatch(/Another DeepCluster lifecycle controller is active/u)
    expect(message).toMatch(/Retry/u)
    expect(message).toMatch(/service status/u)
    expect(message).not.toMatch(/takeover|take over|recover/u)
  } finally {
    release.resolve(undefined)
    await owner
  }
  expect(actionRan).toBe(false)
})

it('destroys unexpected connections without sending a payload', async () => {
  const root = await scratch()
  const endpoint = await disposableEndpoint(root)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const owner = withServiceLifecycleLock(async () => {
    entered.resolve(undefined)
    await release.promise
  }, { pipeName: endpoint, timeoutMs: 5_000 })
  await entered.promise
  const socket = createConnection(endpoint)
  let received = ''
  socket.on('data', (data: Buffer) => { received += data.toString() })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => { resolve() })
      socket.once('error', reject)
    })
    await new Promise<void>((resolve) => {
      socket.once('close', () => { resolve() })
      socket.once('error', () => { resolve() })
    })
    expect(received).toBe('')
  } finally {
    socket.destroy()
    release.resolve(undefined)
    await owner
  }
})

it('rejects an invalid deadline before binding or running the action', async () => {
  const root = await scratch()
  const endpoint = await disposableEndpoint(root)
  for (const timeoutMs of [Number.NaN, -1]) {
    let ran = false
    await expect(withServiceLifecycleLock(async () => { ran = true }, { pipeName: endpoint, timeoutMs }))
      .rejects.toBeInstanceOf(RangeError)
    expect(ran).toBe(false)
  }
})

it.runIf(process.platform === 'win32')('fails visibly for an unbindable named pipe instead of retrying', async () => {
  let ran = false
  const failure = await withServiceLifecycleLock(async () => { ran = true }, { pipeName: '\\\\.\\pipe\\', timeoutMs: 1_000 })
    .catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(failure).not.toBeInstanceOf(ServiceLifecycleLockTimeoutError)
  const code = failure instanceof Error && 'code' in failure ? failure.code : undefined
  expect(['EACCES', 'ENOENT']).toContain(code)
  expect(ran).toBe(false)
})

it.runIf(process.platform !== 'win32')('fails visibly for an unbindable socket path instead of retrying', async () => {
  const root = await scratch()
  const endpoint = path.join(root, 'missing', 'service-lock.sock')
  let ran = false
  await expect(withServiceLifecycleLock(async () => { ran = true }, { pipeName: endpoint, timeoutMs: 1_000 }))
    .rejects.toMatchObject({ code: 'ENOENT' })
  expect(ran).toBe(false)
})
