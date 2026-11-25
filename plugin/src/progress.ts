/** Headless worker activity, streaming token estimates, and provider usage. */
import type { AgentActivity, AgentLog, AgentTokenSample, AgentUsage } from './types.ts'
import { parseMessageReceipt, type TeamMessageReceipt } from './mailbox.ts'

/** One worker's progress observers. */
interface Observers {
  onActivity?: (activity: AgentActivity) => void
  onUsage?: (usage: AgentUsage) => void
  onTokenSample?: (sample: AgentTokenSample) => void
  onTokenError?: (message: string) => void
  onLog?: (entry: AgentLog) => void
  onMessage?: (receipt: TeamMessageReceipt) => void
}

/** Map public tool names to observable operations without inspecting model reasoning. */
function toolActivity(tool: string): AgentActivity['kind'] {
  if (/^(?:bash|shell|exec|terminal|pwsh|powershell)(?:_|$)/.test(tool)) return 'command'
  if (/^(?:read|read_file|read_files|list_directory|list_files|glob|grep|file_search|fs_read|fs_list)(?:_|$)/.test(tool)) return 'read'
  if (/^(?:write|edit|write_file|edit_file|apply_patch|patch_file|fs_write|fs_edit)(?:_|$)/.test(tool)) return 'write'
  return 'tool'
}

/**
 * Argument names whose values are bounded path-like references. Search patterns,
 * queries, and globs are arbitrary content and may contain secrets, so only
 * their names reach the durable log.
 */
const SAFE_ARGUMENT_KEYS = new Set([
  'path', 'file_path', 'filePath', 'paths', 'files', 'cwd', 'directory', 'dir', 'root', 'workspace',
])
const MAX_SAFE_VALUE_CHARS = 200
const MAX_TOOL_SUMMARY_CHARS = 500

/** Reduce arbitrary tool input to argument names and safe path-like values only. */
function summarizeToolInput(input: unknown): string {
  let record: Record<string, unknown> | undefined
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) record = parsed as Record<string, unknown>
    } catch { /* A raw shell or patch payload is intentionally not logged. */ }
  } else if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    record = input as Record<string, unknown>
  }
  if (record === undefined) return 'arguments: unparsed input omitted'
  const keys = Object.keys(record)
  if (keys.length === 0) return 'arguments: none'
  const parts = [`arguments: ${keys.map(key => key.slice(0, 80)).join(', ')}`]
  for (const key of keys) {
    if (!SAFE_ARGUMENT_KEYS.has(key)) continue
    const value = record[key]
    const safe = typeof value === 'string' ? value.slice(0, MAX_SAFE_VALUE_CHARS)
      : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string')
        .slice(0, 5).map(item => item.slice(0, MAX_SAFE_VALUE_CHARS)).join(', ')
        : undefined
    if (safe !== undefined && safe !== '') parts.push(`${key}=${safe}`)
  }
  return parts.join('; ').slice(0, MAX_TOOL_SUMMARY_CHARS)
}

/** Describe a tool result by shape only; file contents and command output stay out of the durable log. */
function summarizeToolResult(status: string, result: unknown): string {
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    const keys = Object.keys(result)
    if (keys.length > 0) return `${status}\nresult keys: ${keys.map(key => key.slice(0, 80)).join(', ')}`.slice(0, MAX_TOOL_SUMMARY_CHARS)
  }
  return status
}

/** Stateful projection scoped to one worker attempt; times use the observer's monotonic clock. */
export class WorkerProgress {
  private started: number | undefined
  private completed: number | undefined
  private stepKey: string | undefined

  /**
   * Observe one parsed headless event and emit public activity, logs, messages, and numeric telemetry.
   * @param event - untrusted JSON value from the worker's stdout.
   * @param now - monotonic observation time in milliseconds.
   * @param observers - synchronous callbacks owned by the coordinator attempt.
   * @param observedAt - controller wall clock used to align live samples with the dashboard.
   * @returns final text when this event is the terminal answer, otherwise undefined.
   */
  accept(event: unknown, now: number, observers: Observers, observedAt = Date.now()): string | undefined {
    if (typeof event !== 'object' || event === null || !('type' in event)) return undefined
    if (event.type === 'deepcluster_message' && 'receipt' in event) {
      const receipt = parseMessageReceipt(event.receipt)
      if (receipt !== undefined) observers.onMessage?.(receipt)
      return undefined
    }
    if (event.type === 'deepcluster_tokens_error') {
      if ('message' in event && typeof event.message === 'string' && event.message.trim() !== '') {
        observers.onTokenError?.(event.message.slice(0, 500))
      }
      return undefined
    }
    if (event.type === 'deepcluster_tokens') {
      if ('tokens' in event && typeof event.tokens === 'number' && Number.isSafeInteger(event.tokens)
        && 'basis' in event && event.basis === 'tokenizer'
        && 'tokenizer' in event && typeof event.tokenizer === 'string' && event.tokenizer.trim() !== '') {
        observers.onTokenSample?.({ tokens: event.tokens, observedAt, basis: 'tokenizer', tokenizer: event.tokenizer })
      }
      return undefined
    }
    if (event.type === 'final' && 'text' in event && typeof event.text === 'string') return event.text
    if (event.type === 'text' && 'text' in event && typeof event.text === 'string') {
      observers.onLog?.({ kind: 'output', text: event.text.slice(0, 2000) })
    }
    if (event.type === 'status' && 'phase' in event) {
      const key = 'turn' in event && 'step' in event ? `${String(event.turn)}:${String(event.step)}` : undefined
      if (event.phase === 'step_start') {
        this.started = now
        this.completed = undefined
        this.stepKey = key
        observers.onActivity?.({ kind: 'thinking', detail: 'Model request in progress' })
      } else if (event.phase === 'step_end') {
        const elapsedMs = (this.completed ?? now) - (this.started ?? now)
        if (this.stepKey !== undefined && this.stepKey === key && elapsedMs > 0 && 'usage' in event) {
          const usage = event.usage
          if (typeof usage === 'object' && usage !== null && 'inputTokens' in usage && 'outputTokens' in usage
            && typeof usage.inputTokens === 'number' && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0
            && typeof usage.outputTokens === 'number' && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0) {
            observers.onUsage?.({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, elapsedMs,
              tokensPerSecond: usage.outputTokens * 1000 / elapsedMs })
          }
        }
        this.started = undefined
        this.completed = undefined
        this.stepKey = undefined
      }
    }
    if (event.type === 'thinking' || event.type === 'text' || event.type === 'tool_call') this.completed ??= now
    if (event.type === 'tool_call' && 'tool' in event && typeof event.tool === 'string') {
      observers.onActivity?.({ kind: toolActivity(event.tool), detail: event.tool })
      const summary = summarizeToolInput('input' in event ? event.input : undefined)
      observers.onLog?.({ kind: toolActivity(event.tool) === 'command' ? 'command' : 'tool',
        text: `${event.tool}\n${summary}`.slice(0, 2000) })
    } else if (event.type === 'tool_result') {
      observers.onActivity?.({ kind: 'idle', detail: 'Tool completed' })
      const status = 'status' in event && typeof event.status === 'string' ? event.status : 'completed'
      observers.onLog?.({ kind: 'tool', text: summarizeToolResult(status, 'result' in event ? event.result : undefined).slice(0, 2000) })
    }
    return undefined
  }
}
