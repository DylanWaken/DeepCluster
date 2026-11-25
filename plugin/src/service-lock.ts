/** Direct Node ownership of the Windows named pipe that serializes DeepCluster service lifecycle commands. */
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

/** Production pipe contended by every DeepCluster lifecycle controller on this computer. */
const DEFAULT_PIPE_NAME = '\\\\.\\pipe\\deepcluster-service-lifecycle-v1'

/** Default total wait for the active lifecycle controller to release the pipe. */
const DEFAULT_TIMEOUT_MS = 300_000

/** Pause between occupancy retries; short enough that a released controller is followed promptly. */
const RETRY_DELAY_MS = 100

/** Endpoint and deadline overrides for {@link withServiceLifecycleLock}. */
export interface ServiceLifecycleLockOptions {
  /** Total wait for an occupied endpoint, in milliseconds; defaults to 300000. */
  readonly timeoutMs?: number
  /** Named pipe or Unix socket to own; tests pass a disposable endpoint instead of the production pipe. */
  readonly pipeName?: string
  /** Cancellation applies while acquiring; callers retain ownership until they release it. */
  readonly signal?: AbortSignal
}

/** Raised when another lifecycle controller kept the endpoint past the caller's deadline. */
export class ServiceLifecycleLockTimeoutError extends Error {
  override readonly name = 'DeepClusterServiceLifecycleLockTimeoutError'

  /**
   * @param pipeName - the contended endpoint.
   * @param timeoutMs - the total wait that elapsed.
   */
  constructor(readonly pipeName: string, readonly timeoutMs: number) {
    super(
      `Another DeepCluster lifecycle controller is active on ${pipeName}; waited ${String(timeoutMs)}ms. `
      + 'Retry after it finishes, or run service status to inspect the running service.',
    )
  }
}

/**
 * Run one lifecycle action while this Node process exclusively owns the lifecycle endpoint.
 * The listening Node server handle is the lock: Windows releases it when this process exits,
 * including a crash, so no PID record or file age can take over an owner. This helper changes
 * no live-service ownership; it only makes other lifecycle commands wait for the action.
 * @param action - lifecycle work to run after the endpoint is listening.
 * @param options - endpoint and bounded wait overrides.
 * @returns the action's result.
 */
export async function withServiceLifecycleLock<T>(
  action: () => Promise<T>,
  options?: ServiceLifecycleLockOptions,
): Promise<T> {
  const release = await acquireServiceLifecycleLock(options)
  return await runAsOwner(release, action)
}

/**
 * Acquire an OS-owned endpoint, including cancellation before the bind completes.
 * @param options - endpoint, bounded wait, and cancellation.
 * @returns idempotent release that settles after the endpoint closes.
 */
export async function acquireServiceLifecycleLock(
  options?: ServiceLifecycleLockOptions,
): Promise<() => Promise<void>> {
  // Tests must not contend on the production pipe, so its default has no in-process caller.
  /* v8 ignore next -- the production endpoint is intentionally never bound by tests. */
  const pipeName = options?.pipeName ?? DEFAULT_PIPE_NAME
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('service lifecycle lock timeoutMs must be a finite non-negative number')
  }
  const deadline = performance.now() + timeoutMs
  for (;;) {
    options?.signal?.throwIfAborted()
    const server = createServer((socket) => { socket.destroy() })
    try {
      await listen(server, pipeName)
    } catch (error) {
      if (!isAddressInUse(error)) throw error
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new ServiceLifecycleLockTimeoutError(pipeName, timeoutMs)
      await delay(Math.min(RETRY_DELAY_MS, remaining), undefined, { signal: options?.signal })
      continue
    }
    if (options?.signal?.aborted === true) {
      await close(server)
      options.signal.throwIfAborted()
    }
    let released: Promise<void> | undefined
    return () => { released ??= close(server); return released }
  }
}

/** Start listening, rejecting only after the async bind outcome is known. */
function listen(server: Server, pipeName: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(pipeName)
  })
}

/** Run the action, then await endpoint release without replacing the action's failure. */
async function runAsOwner<T>(release: () => Promise<void>, action: () => Promise<T>): Promise<T> {
  let primaryFailed = false
  try {
    return await action()
  } catch (error) {
    primaryFailed = true
    throw error
  } finally {
    try {
      await release()
    } catch (error) {
      /* v8 ignore next -- a server that finished listening cannot report close failure. */
      if (!primaryFailed) throw error
    }
  }
}

/** Close the listening handle and settle after the operating system releases the endpoint. */
function close(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      /* v8 ignore else -- a server that finished listening cannot report close failure. */
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

/** Retry only an endpoint already owned by another controller. */
function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
}
