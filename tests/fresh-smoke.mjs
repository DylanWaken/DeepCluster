import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Usage: node tests/fresh-smoke.mjs http://127.0.0.1:3789
const endpoint = new URL(process.argv[2] ?? 'http://127.0.0.1:3789')
assert.equal(endpoint.protocol, 'http:')
assert.ok(['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname), 'Use the loopback API endpoint')

async function request(path, options) {
  const response = await fetch(new URL(path, endpoint), { ...options, redirect: 'error', signal: AbortSignal.timeout(75_000) })
  const body = await response.text()
  assert.ok(response.ok, `${path} returned HTTP ${response.status}: ${body}`)
  return JSON.parse(body)
}

const health = await request('/v1/health')
assert.equal(health.status, 'ready')
assert.ok(!health.admissionBlocked, 'Inspect the recovery issues in /v1/health')

const workspace = await mkdtemp(join(tmpdir(), 'deepcluster-smoke-'))
const markerFile = join(workspace, 'marker.txt')
const marker = randomUUID()
await writeFile(markerFile, `${marker}\n`, 'utf8')
console.log(`Smoke workspace: ${workspace}`)

const plan = `# Fresh installation check
goal: Read the marker in the workspace and return evidence.

## Step inspect: Read the marker
role: tester
depends_on: none
access: read-only
hardware: none
acceptance:
- Marker read

Read marker.txt from the current workspace with a tool. Put its exact value in the evidence for Marker read. Leave all files unchanged.
`
const query = new URLSearchParams({ workspace, maxConcurrency: '1', maxAttempts: '1', maxRepairs: '0' })
const headers = { 'Content-Type': 'text/markdown; charset=utf-8', 'Idempotency-Key': randomUUID() }
const submit = { method: 'POST', headers, body: plan }
await request(`/v1/plans/validate?${query}`, submit)
const runPath = `/v1/runs?${query}&wait=30&view=report`
let report = await request(runPath, submit)
console.log(`Operation: ${report.operationId}`)
const deadline = Date.now() + 10 * 60_000
while (['accepted', 'running', 'cancelling'].includes(report.status)) {
  if (Date.now() >= deadline) {
    await request(`/v1/runs/${report.operationId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    throw new Error('The worker exceeded the ten-minute smoke-test budget')
  }
  report = await request(`/v1/runs/${report.operationId}?wait=30&view=report`)
}

assert.equal(report.status, 'completed', JSON.stringify(report))
assert.equal(report.steps.length, 1)
const [step] = report.steps
assert.equal(step.id, 'inspect')
assert.equal(step.status, 'pass')
assert.equal(step.attempts, 1)
assert.equal(step.auditProblem, undefined)
assert.deepEqual(step.changed ?? [], [])
assert.deepEqual(report.open, [])
assert.ok(step.checks?.some(check => check.includes(marker)), 'The report must contain the value read from disk')
assert.equal(await readFile(markerFile, 'utf8'), `${marker}\n`)
const replay = await request(runPath, submit)
assert.equal(replay.operationId, report.operationId)
assert.equal(replay.status, 'completed')
console.log('Passed: plan validation, one read-only worker, file evidence, and idempotent resubmission.')
