/** Bounded request intake and same-computer admission for the local controller API. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { ApiError, type ApiConfig } from './api-types.ts'

/**
 * Report whether a socket peer address belongs to this computer's loopback interface.
 * @param address - socket remote address, possibly IPv4-mapped IPv6.
 * @returns true for 127.0.0.0/8 and ::1.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const plain = address.replace(/^::ffff:/iu, '')
  if (isIP(plain) === 4) return plain.startsWith('127.')
  return plain === '::1'
}

/**
 * Admit only a non-browser request from this computer before reading a body or accessing files.
 * No credential is required: the loopback peer address is the admission rule. Browser-origin
 * requests and non-loopback Host names are rejected so a web page cannot drive full-access workers.
 * @param request - incoming HTTP request.
 * @param origin - actual dedicated listener origin, including its assigned port.
 */
export function admitApiRequest(request: IncomingMessage, origin: string): void {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(403, 'remote-peer', 'The DeepCluster API accepts requests only from this computer.')
  }
  if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) {
    throw new ApiError(403, 'browser-origin', 'Browser-origin requests are not accepted by the local controller API.')
  }
  let host: URL
  try { host = new URL(`http://${request.headers.host ?? ''}`) } catch {
    throw new ApiError(403, 'invalid-host', 'The request Host must identify this loopback listener.')
  }
  const hostname = host.hostname.replace(/^\[|\]$/gu, '')
  const expected = new URL(origin)
  if (!['127.0.0.1', '::1', 'localhost'].includes(hostname) || host.username !== '' || host.password !== ''
    || host.port !== expected.port || host.pathname !== '/' || host.search !== '' || host.hash !== '') {
    throw new ApiError(403, 'invalid-host', 'The request Host must identify this loopback listener.')
  }
}

/**
 * Read one UTF-8 JSON document, bounding bytes and time without destroying the response on rejection.
 * @param request - authenticated incoming request.
 * @param config - byte and intake deadline limits.
 * @param signal - API shutdown cancellation.
 * @returns decoded JSON; malformed, oversized, encoded, or incomplete bodies are rejected.
 */
export async function readApiJson(request: IncomingMessage, config: ApiConfig, signal: AbortSignal): Promise<unknown> {
  if (!JSON_TYPE.test(request.headers['content-type'] ?? '')) {
    throw new ApiError(415, 'content-type', 'Send application/json encoded as UTF-8.')
  }
  return parseJson(await readApiBytes(request, config, signal))
}

/** A run submission body: a JSON request document or one raw Markdown plan. */
export type ApiRunBody = { readonly kind: 'json'; readonly value: unknown } | { readonly kind: 'markdown'; readonly text: string }

/**
 * Read a run submission as JSON or as one UTF-8 Markdown plan (`text/markdown` or `text/plain`).
 * @param request - admitted incoming request.
 * @param config - byte and intake deadline limits.
 * @param signal - API shutdown cancellation.
 * @returns the decoded body; other content types and invalid UTF-8 are rejected.
 */
export async function readApiRunBody(request: IncomingMessage, config: ApiConfig, signal: AbortSignal): Promise<ApiRunBody> {
  const type = request.headers['content-type'] ?? ''
  if (JSON_TYPE.test(type)) return { kind: 'json', value: parseJson(await readApiBytes(request, config, signal)) }
  if (!/^text\/(?:markdown|plain)(?:\s*;\s*charset=utf-8)?$/iu.test(type)) {
    throw new ApiError(415, 'content-type', 'Send application/json, or one Markdown plan as text/markdown or text/plain, encoded as UTF-8.')
  }
  const bytes = await readApiBytes(request, config, signal)
  try { return { kind: 'markdown', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } } catch {
    throw new ApiError(400, 'invalid-text', 'The plan body must be valid UTF-8 text.')
  }
}

const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu

/** Decode one complete UTF-8 JSON body. */
function parseJson(bytes: Buffer): unknown {
  try { const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); return parsed } catch {
    throw new ApiError(400, 'invalid-json', 'The request body must contain valid UTF-8 JSON.')
  }
}

/** Read one bounded, uncompressed request body. */
async function readApiBytes(request: IncomingMessage, config: ApiConfig, signal: AbortSignal): Promise<Buffer> {
  if (request.destroyed) throw new ApiError(400, 'incomplete-body', 'The request disconnected before its body was complete.')
  const encoding = request.headers['content-encoding']
  if (encoding !== undefined && encoding !== 'identity') throw new ApiError(415, 'content-encoding', 'Compressed request bodies are not accepted.')
  const length = request.headers['content-length']
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > config.maxBodyBytes)) {
    throw new ApiError(413, 'body-limit', 'The request body exceeds the configured byte limit.')
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      request.off('data', data); request.off('end', end); request.off('error', failure); request.off('close', incomplete)
      signal.removeEventListener('abort', abort)
      if (error !== undefined) { request.pause(); reject(error) } else resolve(Buffer.concat(chunks, size))
    }
    const data = (chunk: Buffer): void => {
      size += chunk.byteLength
      if (size > config.maxBodyBytes) { finish(new ApiError(413, 'body-limit', 'The request body exceeds the configured byte limit.')); return }
      chunks.push(chunk)
    }
    const end = (): void => { finish() }
    const failure = (error: Error): void => { finish(error) }
    const incomplete = (): void => { finish(new ApiError(400, 'incomplete-body', 'The request ended before its body was complete.')) }
    const abort = (): void => { finish(new ApiError(503, 'shutting-down', 'The API is shutting down.')) }
    const timer = setTimeout(() => { finish(new ApiError(408, 'request-timeout', 'The request body did not arrive before the intake deadline.')) }, config.requestTimeoutMs)
    timer.unref()
    request.on('data', data); request.once('end', end); request.once('error', failure); request.once('close', incomplete)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/**
 * Send a complete JSON response without caching or cross-origin permissions.
 * @param response - request-owned response.
 * @param status - HTTP response status.
 * @param value - JSON-serializable response fields.
 */
export function sendApiJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...(status >= 400 ? { connection: 'close' } : {}) })
  response.end(JSON.stringify(value))
}
