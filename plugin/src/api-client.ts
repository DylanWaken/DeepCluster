/** Local HTTP transport shared by command, MCP, and dashboard adapters. */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { apiOperationViewSchema, type ApiOperationView } from './api-types.ts'
import { validateApiEndpoint } from './assets.ts'
import type { DeepClusterOptions } from './types.ts'
import type { KnowledgeReference } from './knowledge-types.ts'
import type { ClusterSessionReference } from './native-sessions.ts'

/** One request to the dedicated local API. */
export interface ApiRequest {
  readonly method: 'GET' | 'POST'
  /** Absolute API path and optional encoded query, beginning with /v1/. */
  readonly path: string
  readonly body?: unknown
  readonly signal?: AbortSignal
  readonly idempotencyKey?: string
}

/** HTTP error response; a server failure can follow admission of a mutating request. */
export class ApiRequestError extends Error {
  override readonly name = 'DeepClusterApiRequestError'
  constructor(readonly status: number, message: string) { super(message) }
}

/**
 * Send one request without redirects or automatic retries.
 * @param options - saved local connection and HTTP deadline.
 * @param request - API path, JSON body, and optional cancellation.
 * @returns decoded JSON requiring operation-specific validation by the consumer.
 */
export async function apiRequest(options: DeepClusterOptions, request: ApiRequest): Promise<unknown> {
  if (options.apiEndpoint === undefined) throw new Error('DeepCluster API endpoint is not configured. Ask for its endpoint address or the DSH path to launch it, then save apiEndpoint and dshPath in the skill and configuration.')
  const endpoint = validateApiEndpoint(options.apiEndpoint)
  if (!request.path.startsWith('/v1/')) throw new Error('DeepCluster API requests must use /v1/ paths')
  const url = new URL(request.path, endpoint)
  if (url.origin !== endpoint || !url.pathname.startsWith('/v1/')) throw new Error('DeepCluster API request escaped its configured origin')
  const deadline = AbortSignal.timeout(options.apiRequestTimeoutMs)
  const response = await fetch(url, {
    method: request.method, redirect: 'error',
    signal: request.signal === undefined ? deadline : AbortSignal.any([deadline, request.signal]),
    headers: {
      Accept: 'application/json',
      ...request.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...request.idempotencyKey === undefined ? {} : { 'Idempotency-Key': request.idempotencyKey },
    },
    ...request.body === undefined ? {} : { body: JSON.stringify(request.body) },
  })
  const decoded: unknown = await response.json()
  if (!response.ok) {
    let message = `DeepCluster API returned HTTP ${response.status}`
    if (typeof decoded === 'object' && decoded !== null && 'error' in decoded) {
      const error = decoded.error
      if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') message += `: ${error.message}`
    }
    throw new ApiRequestError(response.status, message)
  }
  return decoded
}

/** Wire submission fields; the API resolves omitted deployment defaults. */
export interface ApiSubmission {
  readonly workspace: string
  readonly plans: readonly string[]
  /** Exact workspace revisions selected by the submitting supervisor. */
  readonly knowledge?: readonly KnowledgeReference[]
  /** Exact native worker generation; omission requests disposable execution. */
  readonly session?: ClusterSessionReference
  readonly maxConcurrency?: number
  readonly timeoutMs?: number
  readonly maxAttempts?: number
  readonly maxRepairs?: number
  readonly lease?: { readonly ttlMs?: number; readonly waitMs?: number }
}

/**
 * Submit and follow one operation, forwarding owner cancellation through the API.
 * @param options - configured HTTP connection and polling interval.
 * @param submission - exact JSON body retained for idempotent retries.
 * @param controls - owner signal, durable request key, and accepted-operation observer.
 * @returns terminal server metadata after normal completion or acknowledged cancellation.
 */
export async function submitAndWait(
  options: DeepClusterOptions,
  submission: ApiSubmission,
  controls: {
    readonly signal?: AbortSignal
    readonly idempotencyKey?: string
    readonly onAccepted?: (operation: ApiOperationView) => void
  } = {},
): Promise<ApiOperationView> {
  controls.signal?.throwIfAborted()
  const idempotencyKey = controls.idempotencyKey ?? randomUUID()
  let operation: ApiOperationView
  try {
    // Preserve the accepted operation identity if owner cancellation arrives during submission.
    const decoded = await apiRequest(options, { method: 'POST', path: '/v1/runs', body: submission, idempotencyKey })
    operation = apiOperationViewSchema.parse(decoded)
  } catch (error) {
    if (error instanceof ApiRequestError && error.status < 500) throw error
    const detail = error instanceof ApiRequestError ? ` ${error.message}` : ''
    throw new Error(`DeepCluster submission outcome is unknown; retain and retry the same JSON body with Idempotency-Key ${idempotencyKey}.${detail}`, { cause: error })
  }
  controls.onAccepted?.(operation)
  const operationPath = `/v1/runs/${operation.operationId}`
  const isCancelled = (): boolean => controls.signal?.aborted === true
  while (isActive(operation)) {
    if (isCancelled()) {
      try {
        operation = apiOperationViewSchema.parse(await apiRequest(options, { method: 'POST', path: `${operationPath}/cancel`, body: {} }))
      } catch (error) {
        throw new Error(`DeepCluster cancellation outcome is unknown for operation ${operation.operationId}; inspect ${operationPath} before assuming its workers stopped.`, { cause: error })
      }
      if (isActive(operation)) throw new Error(`DeepCluster cancellation did not confirm teardown for operation ${operation.operationId}`)
      return operation
    }
    try {
      await delay(options.apiPollIntervalMs, undefined, controls.signal === undefined ? undefined : { signal: controls.signal })
    } catch (error) {
      if (!isCancelled()) throw error
      continue
    }
    try {
      operation = apiOperationViewSchema.parse(await apiRequest(options, { method: 'GET', path: operationPath, ...controls.signal === undefined ? {} : { signal: controls.signal } }))
    } catch (error) {
      if (isCancelled()) continue
      throw new Error(`DeepCluster status is unknown for operation ${operation.operationId}; inspect ${operationPath} before further action.`, { cause: error })
    }
  }
  return operation
}

/** States in which the server may still own running workers or teardown. */
function isActive(operation: ApiOperationView): boolean {
  return operation.status === 'accepted' || operation.status === 'running' || operation.status === 'cancelling'
}
