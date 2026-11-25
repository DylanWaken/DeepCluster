/**
 * A Model Context Protocol server over stdio, so a planner that speaks MCP can
 * call DeepCluster as a tool instead of shelling out.
 *
 * Transport is newline-delimited JSON-RPC 2.0, which is what MCP defines for
 * stdio. The server answers `initialize`, `tools/list`, and `tools/call`, and
 * ignores notifications.
 *
 * @module @deepseek-ai/dsh-experimental-deep-cluster/mcp
 */

import type { DeepClusterOptions, HandoffRequest, HandoffResult } from './types.ts'
import { createInterface } from 'node:readline'
import { apiRequest } from './api-client.ts'

/** Protocol revision this server implements. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** Minimal JSON-RPC request fields the server consumes. */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id?: string | number | null
  readonly method: string
  readonly params?: unknown
}

/** Anything the server may write back. */
export interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

/** MCP task fields, including the retained key needed to recover an unknown HTTP submission outcome. */
export interface McpHandoffRequest extends HandoffRequest {
  /** Reuse only with the identical task, plan, workspace, and execution options. */
  readonly idempotencyKey?: string
}

/** What the server needs to serve one handoff. */
export interface McpDependencies {
  readonly options: DeepClusterOptions
  readonly run: (request: McpHandoffRequest) => Promise<HandoffResult>
}

/**
 * Describe tools advertised to MCP planners.
 * @returns tool names, descriptions, and input schemas.
 */
export function toolDefinitions(): unknown[] {
  return [
    {
      name: 'cluster_run',
      description: 'Execute a structured task plan through DeepCluster scheduling, resource leases and recorded acceptance checks. Returns the coordinator outcome.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task in the planner\'s own words.' },
          plan: { type: 'string', description: 'Required plan with roles, dependencies, resource declarations and acceptance checks, as Markdown.' },
          cwd: { type: 'string', description: 'Repository directory to work in and store the task journal.' },
          timeoutMs: { type: 'integer', minimum: 1, description: 'Per-worker deadline in milliseconds.' },
          idempotencyKey: {
            type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\x21-\\x7e]+$',
            description: 'Retained HTTP submission key. Reuse with identical task, plan, cwd, and timeoutMs after an unknown submission outcome.',
          },
        },
        required: ['task', 'plan'],
      },
    },
    {
      name: 'cluster_info',
      description: 'Read health and admission limits from the dedicated local DeepCluster API.',
      inputSchema: { type: 'object', properties: {} },
    },
  ]
}

/** Read a required string field from untrusted tool arguments. */
function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`deep-cluster: "${key}" must be a non-blank string`)
  }
  return value
}

/** Build the request an MCP `cluster_run` call describes. */
function toHandoffRequest(args: Record<string, unknown>): McpHandoffRequest {
  const idempotencyKey = args.idempotencyKey === undefined ? undefined : requiredString(args, 'idempotencyKey')
  if (idempotencyKey !== undefined && !/^[\x21-\x7e]{1,128}$/u.test(idempotencyKey)) {
    throw new Error('deep-cluster: idempotencyKey must contain 1–128 printable ASCII characters without spaces')
  }
  const request: McpHandoffRequest = { task: requiredString(args, 'task'), ...idempotencyKey === undefined ? {} : { idempotencyKey } }
  request.plan = requiredString(args, 'plan')
  if (args.cwd !== undefined) request.cwd = requiredString(args, 'cwd')
  if (args.timeoutMs !== undefined) {
    if (typeof args.timeoutMs !== 'number' || !Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > 2_147_483_647) {
      throw new Error('deep-cluster: timeoutMs must be an integer from 1 to 2147483647')
    }
    request.timeoutMs = args.timeoutMs
  }
  return request
}

/**
 * Answer one request.
 * @param dependencies - settings and the run function.
 * @param request - parsed JSON-RPC request.
 * @returns the response to write, or undefined for a notification.
 */
export async function dispatch(
  dependencies: McpDependencies,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | undefined> {
  if (request.id === undefined) return undefined // notification
  const id = request.id
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } })
  switch (request.method) {
    case 'initialize':
      return reply({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'deep-cluster', version: '0.2.1-rc.2' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: toolDefinitions() })
    case 'tools/call': {
      if (!isRecord(request.params)) return fail(-32602, 'tool parameters must be an object')
      const name = request.params.name
      const args = request.params.arguments ?? {}
      if (!isRecord(args)) return fail(-32602, 'tool arguments must be an object')
      if (name === 'cluster_info') {
        try {
          const health = await apiRequest(dependencies.options, { method: 'GET', path: '/v1/health' })
          return reply({ content: [{ type: 'text', text: JSON.stringify(health) }] })
        } catch (error) {
          return reply({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true })
        }
      }
      if (name !== 'cluster_run') return fail(-32602, `unknown tool: ${String(name)}`)
      try {
        const result = await dependencies.run(toHandoffRequest(args))
        return reply({
          content: [{ type: 'text', text: result.stdout.trim() === '' ? '(no output)' : result.stdout }],
          isError: !result.ok,
        })
      } catch (error) {
        return reply({
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        })
      }
    }
    default:
      return fail(-32601, `unknown method: ${request.method}`)
  }
}

/** Validate untrusted JSON object containers before reading their fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse the stdio JSON-RPC envelope; notification ids may be omitted. */
function isRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && value.jsonrpc === '2.0' && typeof value.method === 'string'
    && (value.id === undefined || value.id === null || typeof value.id === 'string' || typeof value.id === 'number')
}

/**
 * Serve MCP over a pair of line streams until input ends.
 * @param dependencies - settings and the run function.
 * @param input - newline-delimited request stream.
 * @param output - newline-delimited response sink.
 * @param signal - owner cancellation; closes input observation before joining active calls.
 */
export async function serveStdio(
  dependencies: McpDependencies,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) return
  const pending = new Set<Promise<void>>()
  let failure: Error | undefined
  const lines = createInterface({ input, crlfDelay: Infinity, ...signal === undefined ? {} : { signal } })
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue
      let request: unknown
      try {
        request = JSON.parse(line)
      } catch (_error) {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`)
        continue
      }
      if (!isRequest(request)) {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } })}\n`)
        continue
      }
      const work = dispatch(dependencies, request).then((response) => {
        if (response !== undefined) output.write(`${JSON.stringify(response)}\n`)
      }).catch((error: unknown) => { failure ??= error instanceof Error ? error : new Error(String(error)); lines.close() })
      pending.add(work)
      void work.then(() => { pending.delete(work) })
    }
  } finally {
    lines.close()
    await Promise.all(pending)
  }
  if (failure !== undefined) throw failure
}
