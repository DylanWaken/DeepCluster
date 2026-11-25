/** Request intake, loopback admission, and browser-origin rejection for the local API. */
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { expect, it, onTestFinished } from 'vitest'
import { Config } from '../src/api.ts'
import { admitApiRequest, isLoopbackAddress, readApiJson } from '../src/api-http.ts'

const origin = 'http://127.0.0.1:47890'

/** Build an intake request with an explicit socket peer and listener Host. */
function requestFrom(remote: string | undefined, headers: Record<string, string> = {}): IncomingMessage {
  const request = new IncomingMessage(new Socket())
  Object.defineProperty(request.socket, 'remoteAddress', { configurable: true, value: remote })
  request.headers.host = '127.0.0.1:47890'
  Object.assign(request.headers, headers)
  return request
}

function refusal(action: () => void): unknown {
  try { action() } catch (error) { return error }
  throw new Error('expected the request to be refused')
}

it('admits loopback peers without any credential', () => {
  for (const remote of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) {
    expect(() => { admitApiRequest(requestFrom(remote, { authorization: 'Bearer ignored' }), origin) }).not.toThrow()
  }
})

it('rejects a non-loopback peer with 403 remote-peer', () => {
  for (const remote of ['10.0.0.1', '192.168.1.20', '::2', '::ffff:10.0.0.1', undefined]) {
    expect(refusal(() => { admitApiRequest(requestFrom(remote), origin) })).toMatchObject({
      status: 403, code: 'remote-peer', message: expect.stringContaining('only from this computer') as unknown,
    })
  }
})

it('classifies loopback addresses including 127.0.0.0/8, ::1, and IPv4-mapped IPv6', () => {
  for (const address of ['127.0.0.1', '127.0.0.2', '127.255.255.255', '::1', '::ffff:127.0.0.1']) {
    expect(isLoopbackAddress(address), address).toBe(true)
  }
  for (const address of [undefined, '10.0.0.1', '::2', '::ffff:10.0.0.1', 'localhost', '']) {
    expect(isLoopbackAddress(address), String(address)).toBe(false)
  }
})

it('rejects browser origins and Host names that do not identify the listener', () => {
  expect(refusal(() => { admitApiRequest(requestFrom('127.0.0.1', { origin: 'null' }), origin) }))
    .toMatchObject({ status: 403, code: 'browser-origin' })
  expect(refusal(() => { admitApiRequest(requestFrom('127.0.0.1', { 'sec-fetch-site': 'same-origin' }), origin) }))
    .toMatchObject({ status: 403, code: 'browser-origin' })
  for (const host of ['attacker.invalid:47890', '127.0.0.1:47891', 'localhost:4790', '127.0.0.1.evil:47890']) {
    expect(refusal(() => { admitApiRequest(requestFrom('127.0.0.1', { host }), origin) }))
      .toMatchObject({ status: 403, code: 'invalid-host' })
  }
  expect(() => { admitApiRequest(requestFrom('127.0.0.1', { host: '127.0.0.1:47890' }), origin) }).not.toThrow()
  expect(() => { admitApiRequest(requestFrom('127.0.0.1', { host: 'localhost:47890' }), origin) }).not.toThrow()
})

it('keeps the error listener through aborted until the disconnect error settles intake', async () => {
  const socket = new Socket(), request = new IncomingMessage(socket), shutdown = new AbortController()
  onTestFinished(() => { shutdown.abort(); request.destroy(); socket.destroy() })
  request.headers['content-type'] = 'application/json'
  const config = Config({ stateDirectory: process.cwd(), leaseRoot: process.cwd() })
  const reading = readApiJson(request, config, shutdown.signal)
  const failure = Object.assign(new Error('client disconnected'), { code: 'ECONNRESET' })
  const rejected = expect(reading).rejects.toBe(failure)
  request.emit('aborted')
  expect(request.listenerCount('error')).toBe(1)
  request.emit('error', failure)
  await rejected
  expect(request.listenerCount('data')).toBe(0)
  expect(request.listenerCount('end')).toBe(0)
  expect(request.listenerCount('error')).toBe(0)
  expect(request.listenerCount('close')).toBe(0)
})

it('rejects a request already destroyed before body intake starts', async () => {
  const socket = new Socket(), request = new IncomingMessage(socket)
  onTestFinished(() => { socket.destroy() })
  request.headers['content-type'] = 'application/json'
  request.destroy()
  const config = Config({ stateDirectory: process.cwd(), leaseRoot: process.cwd() })
  await expect(readApiJson(request, config, new AbortController().signal)).rejects.toMatchObject({ code: 'incomplete-body' })
})
