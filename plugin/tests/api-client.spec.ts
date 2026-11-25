/** Real loopback HTTP transport, cancellation ownership, and saved connection behavior. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { apiRequest, ApiRequestError, submitAndWait } from '../src/api-client.ts'
import { resolveOptions, skillMarkdown } from '../src/assets.ts'
import { loadConfig, resolveConfiguredOptions, saveConfig } from '../src/config.ts'
import type { DeepClusterOptions } from '../src/types.ts'
import { listenLoopback } from './loopback-server.ts'
import { knowledgeReferenceSchema } from '../src/knowledge-types.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const ID = 'd1034139-6544-4276-849f-82433561bab8'

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'deep-cluster-http-client-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void): Promise<DeepClusterOptions> {
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch((error: unknown) => {
    response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: String(error) } }))
  }) })
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    }))
  })
  const address = await listenLoopback(server)
  return resolveOptions({ apiEndpoint: `http://127.0.0.1:${address.port}`, apiPollIntervalMs: 1 })
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value))
}

function operation(workspace: string, status = 'running'): object {
  return { operationId: ID, workspace, status, runId: null, createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z', result: null, error: null }
}

it('sends one idempotent batch submission without credentials before polling its operation', async () => {
  const workspace = await scratch()
  const requests: {
    method: string | undefined
    url: string | undefined
    authorization: string | undefined
    key: string | string[] | undefined
    body: string
  }[] = []
  const options = await fixture(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, key: request.headers['idempotency-key'], body })
    json(response, operation(workspace, request.method === 'POST' ? 'running' : 'completed'), request.method === 'POST' ? 202 : 200)
  })
  const submission = { workspace, plans: ['first complete plan', 'second complete plan'], maxConcurrency: 2, maxAttempts: 1, maxRepairs: 0,
    knowledge: [knowledgeReferenceSchema.parse({ id: ID, revision: 2 })] }
  const result = await submitAndWait(options, submission, { idempotencyKey: 'retained-request-key' })
  expect(result.status).toBe('completed')
  expect(requests).toHaveLength(2)
  expect(requests[0]).toMatchObject({ method: 'POST', url: '/v1/runs', key: 'retained-request-key' })
  expect(requests[0]?.authorization).toBeUndefined()
  expect(JSON.parse(requests[0]?.body ?? '')).toEqual(submission)
  expect(requests[1]).toMatchObject({ method: 'GET', url: `/v1/runs/${ID}` })
  expect(requests[1]?.authorization).toBeUndefined()
})

it('retains an accepted operation when cancellation arrives during submission and joins server teardown', async () => {
  const workspace = await scratch()
  const submitted = Promise.withResolvers<undefined>()
  const respond = Promise.withResolvers<undefined>()
  const cancelling = Promise.withResolvers<undefined>()
  const stopped = Promise.withResolvers<undefined>()
  const abort = new AbortController()
  const calls: string[] = []
  let cancellationBody = ''
  let cancellationContentType: string | undefined
  const options = await fixture(async (request, response) => {
    calls.push(request.url ?? '')
    if (request.url === '/v1/runs') { submitted.resolve(undefined); await respond.promise; json(response, operation(workspace), 202) }
    else {
      cancellationContentType = request.headers['content-type']
      for await (const chunk of request) cancellationBody += String(chunk)
      cancelling.resolve(undefined); await stopped.promise; json(response, operation(workspace, 'cancelled'))
    }
  })
  let settled = false
  const work = submitAndWait(options, { workspace, plans: ['plan'] }, { signal: abort.signal }).finally(() => { settled = true })
  await submitted.promise
  abort.abort(); respond.resolve(undefined)
  await cancelling.promise
  expect(settled).toBe(false)
  stopped.resolve(undefined)
  expect((await work).status).toBe('cancelled')
  expect(calls).toEqual(['/v1/runs', `/v1/runs/${ID}/cancel`])
  expect(cancellationContentType).toBe('application/json')
  expect(cancellationBody).toBe('{}')
})

it('reports the retained idempotency key after a lost submission response and never resubmits automatically', async () => {
  let calls = 0
  const options = await fixture((_request, response) => { calls++; response.destroy() })
  await expect(submitAndWait(options, { workspace: await scratch(), plans: ['plan'] }, { idempotencyKey: 'recover-this-key' }))
    .rejects.toThrow('Idempotency-Key recover-this-key')
  expect(calls).toBe(1)
})

it('retains an autogenerated key after HTTP 503 follows admission and recovers the original operation without redispatch', async () => {
  const workspace = await scratch()
  const admitted = new Map<string, string>()
  let dispatches = 0
  let requests = 0
  const options = await fixture(async (request, response) => {
    requests++
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string') throw new Error('Submission must supply one idempotency key')
    const previous = admitted.get(key)
    if (previous === undefined) {
      admitted.set(key, body); dispatches++
      json(response, { error: { code: 'state-unavailable', message: 'Operation metadata could not be saved.' } }, 503)
    } else if (previous !== body) json(response, { error: { code: 'idempotency-conflict', message: 'Different body.' } }, 409)
    else json(response, operation(workspace, 'completed'), 202)
  })
  const submission = { workspace, plans: ['complete plan'], maxAttempts: 1 }
  const failure: unknown = await submitAndWait(options, submission).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  if (!(failure instanceof Error)) throw new Error('Expected an unknown submission outcome')
  const [key] = admitted.keys()
  if (key === undefined) throw new Error('Fixture did not admit the submission')
  expect(failure.message).toContain('submission outcome is unknown')
  expect(failure.message).toContain(`Idempotency-Key ${key}`)
  expect(failure.message).toContain('HTTP 503: Operation metadata could not be saved.')
  expect(requests).toBe(1)
  const recovered = await submitAndWait(options, submission, { idempotencyKey: key })
  expect(recovered).toMatchObject({ operationId: ID, status: 'completed' })
  expect(requests).toBe(2)
  expect(dispatches).toBe(1)
})

it.each([400, 401, 409, 429])('keeps HTTP %i submission refusals explicit', async (status) => {
  const options = await fixture((_request, response) => {
    json(response, { error: { code: 'refused', message: 'The request was refused.' } }, status)
  })
  await expect(submitAndWait(options, { workspace: await scratch(), plans: ['plan'] })).rejects.toMatchObject({
    name: 'DeepClusterApiRequestError', status, message: `DeepCluster API returned HTTP ${status}: The request was refused.`,
  })
})

it('rejects redirects without forwarding credentials to another route', async () => {
  const routes: string[] = []
  const options = await fixture((request, response) => {
    routes.push(request.url ?? '')
    response.writeHead(302, { Location: '/different' }); response.end()
  })
  await expect(apiRequest(options, { method: 'GET', path: '/v1/health' })).rejects.toThrow()
  expect(routes).toEqual(['/v1/health'])
})

it('preserves explicit server refusals and rejects malformed operation responses', async () => {
  const refused = await fixture((_request, response) =>{  json(response, { error: { code: 'unauthorized', message: 'authentication required' } }, 401) })
  await expect(apiRequest(refused, { method: 'GET', path: '/v1/health' })).rejects.toBeInstanceOf(ApiRequestError)
  const invalid = await fixture((_request, response) =>{  json(response, { operationId: ID, status: 'not-a-state' }, 202) })
  await expect(submitAndWait(invalid, { workspace: await scratch(), plans: ['plan'] })).rejects.toThrow()
})

it('requires a saved connection and accepts only literal loopback HTTP origins', async () => {
  await expect(apiRequest(resolveOptions(), { method: 'GET', path: '/v1/health' })).rejects.toThrow('Ask for its endpoint address or the DSH path')
  for (const apiEndpoint of ['http://example.com:3789', 'http://localhost:3789', 'https://127.0.0.1:3789', 'http://127.0.0.1:3789/path', 'http://user:pass@127.0.0.1:3789']) {
    expect(() => resolveOptions({ apiEndpoint })).toThrow('literal loopback HTTP origin')
  }
  expect(resolveOptions({ apiEndpoint: 'http://[::1]:3789/' }).apiEndpoint).toBe('http://[::1]:3789')
})

it('round-trips connection settings without dropping execution fields and renders them into the skill', async () => {
  const root = await scratch()
  const file = path.join(root, 'config.json')
  const cliPath = `${root}/worker-wrapper.exe`
  const serviceCliPath = `${root}/dsh.exe`
  saveConfig({ maxOutputBytes: 4096, terminationGraceMs: 9000, profile: 'custom', cliPath, serviceCliPath, apiEndpoint: 'http://127.0.0.1:3789', dshPath: root }, file)
  const options = resolveConfiguredOptions({ commandName: 'Delegation' }, file)
  saveConfig(options, file)
  expect(loadConfig(file)).toMatchObject({ maxOutputBytes: 4096, terminationGraceMs: 9000, profile: 'custom', commandName: 'Delegation', cliPath, serviceCliPath, dshPath: root })
  const skill = skillMarkdown(options, 'codex')
  expect(skill).toContain('apiEndpoint: http://127.0.0.1:3789')
  expect(skill).toContain(`dshPath: ${root}`)
  expect(skill.replaceAll(root, '<DSH checkout>')).toMatchSnapshot('HTTP-only delegation workflow')
})

it('validates and preserves the configured lifecycle contention deadline', async () => {
  const root = await scratch(), file = path.join(root, 'config.json')
  saveConfig({ serviceLifecycleWaitMs: 12345 }, file)
  expect(resolveConfiguredOptions({}, file).serviceLifecycleWaitMs).toBe(12345)
  expect(resolveOptions().serviceLifecycleWaitMs).toBe(300000)
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => resolveOptions({ serviceLifecycleWaitMs: invalid })).toThrow('serviceLifecycleWaitMs')
  }
})

it('rejects a saved configuration that still names the retired apiTokenFile', async () => {
  const root = await scratch(), file = path.join(root, 'config.json')
  await writeFile(file, JSON.stringify({ apiEndpoint: 'http://127.0.0.1:3789', apiTokenFile: path.join(root, 'token') }))
  expect(() => loadConfig(file)).toThrow(/apiTokenFile is retired/u)
})
